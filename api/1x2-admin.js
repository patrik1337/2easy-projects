const {
  kv, kvReady, getData, normalizeFeedMatch, gradeMatch, regradeMatch,
  venueDateStr, kickoffMs, buildBonus, getCurrent, getResult,
  setPrediction, findPlayerByName, findAnyPlayerIdByName, validateBonusAnswers, hashToObj,
  regenerateCommentary, reassignPlayerAcrossMatches,
  validateCustomBonusDefs, matchHasPredictions, updateMatchMeta, getMatchBonusDefs, withBonus,
} = require('./_wc');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '');
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!kvReady()) return res.status(500).json({ error: 'Storage not configured' });

  const body = req.body || {};
  const action = body.action;

  try {
    // List the feed's fixtures for a date (helper for the admin picker).
    if (action === 'listFixtures') {
      const date = body.date;
      if (!date) return res.status(400).json({ error: 'date required' });
      const { matches, teamById } = await getData();
      const fixtures = matches
        .map((fm) => ({ fm, ko: kickoffMs(fm.local_date, fm.stadium_id) }))
        .filter((x) => venueDateStr(x.fm.local_date) === date)
        .sort((a, b) => a.ko - b.ko)
        .map((x) => {
          const nm = normalizeFeedMatch(x.fm, teamById, date);
          return {
            refId: String(x.fm.id), matchId: nm.matchId, kickoffMs: nm.kickoffMs,
            home: nm.home, away: nm.away, group: nm.group, stage: nm.stage,
            real: Boolean(nm.home && nm.away),
          };
        });
      return res.status(200).json({ fixtures });
    }

    // List matches that have been set via admin (newest first), with graded status
    // and result — powers the "pick a match" dropdowns in sections 2-4 instead
    // of typing a matchId by hand.
    if (action === 'listMatches') {
      const [ids] = await kv([['ZREVRANGE', '1x2:history', '0', '49']]);
      const idList = Array.isArray(ids) ? ids : [];
      const metaCmds = idList.map((id) => ['GET', `1x2:matchmeta:${id}`]);
      const resultCmds = idList.map((id) => ['GET', `1x2:result:${id}`]);
      const predCountCmds = idList.map((id) => ['HLEN', `1x2:pred:${id}`]);
      const [metas, results, predCounts] = await Promise.all([kv(metaCmds), kv(resultCmds), kv(predCountCmds)]);
      const cur = await getCurrent();
      const curId = cur && cur.matchId;
      const matches = idList.map((id, i) => {
        let m = null, r = null;
        try { m = metas[i] ? withBonus(JSON.parse(metas[i])) : null; } catch (_) {}
        try { r = results[i] ? JSON.parse(results[i]) : null; } catch (_) {}
        if (!m) return null;
        return {
          matchId: id, home: m.home, away: m.away, group: m.group, stage: m.stage,
          dateStr: m.dateStr, bonus: m.bonus || [], bonusMode: m.bonusMode === 'custom' ? 'custom' : 'standard',
          predictionCount: Number(predCounts[i]) || 0,
          graded: Boolean(r), result: r, isCurrent: id === curId,
        };
      }).filter(Boolean);
      // Fallback: the currently-active match may predate history tracking (set
      // before this feature existed) and so wouldn't be in 1x2:history yet —
      // include it anyway so the dropdown isn't empty on first use.
      if (curId && !matches.some((m) => m.matchId === curId)) {
        const r = await getResult(curId);
        const [predCount] = await kv([['HLEN', `1x2:pred:${curId}`]]);
        matches.unshift({
          matchId: curId, home: cur.home, away: cur.away, group: cur.group,
          stage: cur.stage, dateStr: cur.dateStr, bonus: cur.bonus || [],
          bonusMode: cur.bonusMode === 'custom' ? 'custom' : 'standard',
          predictionCount: Number(predCount) || 0,
          graded: Boolean(r), result: r, isCurrent: true,
        });
      }
      return res.status(200).json({ matches });
    }

    // Pin / override the match of the day.
    if (action === 'setMatch') {
      const { date, refId, custom } = body;
      if (!date) return res.status(400).json({ error: 'date required' });
      let match;
      if (refId) {
        const { matches, teamById } = await getData();
        const fm = matches.find((m) => String(m.id) === String(refId));
        if (!fm) return res.status(400).json({ error: 'fixture not found' });
        match = normalizeFeedMatch(fm, teamById, date);
        match.source = 'admin-feed';
      } else if (custom && custom.home && custom.away && custom.kickoff) {
        // custom.kickoff = "YYYY-MM-DDTHH:MM" in Stockholm local time (CEST during the tournament)
        const koMs = Date.parse(`${custom.kickoff}:00+02:00`);
        // matchId includes the matchup, not just the date — two custom matches
        // can land on the same calendar day (e.g. a knockout schedule with a gap
        // between kickoffs). Keying by date alone made a second match collide
        // with the first one's matchId, silently reusing its predictions/result/
        // graded-flag. Still deterministic per matchup, so re-submitting the same
        // fixture (e.g. to fix a typo'd kickoff time) resolves to the same id.
        const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 16);
        match = {
          matchId: `c-${date}-${slug(custom.home.name)}-${slug(custom.away.name)}`, dateStr: date, kickoffMs: Number.isFinite(koMs) ? koMs : null,
          home: custom.home, away: custom.away, group: custom.group || '',
          stage: custom.stage || 'knockout', source: 'admin-custom',
        };
      } else {
        return res.status(400).json({ error: 'provide refId or a full custom match' });
      }
      // Attach the bonus questions (admin-graded extras) to this match.
      match.bonus = buildBonus(match);
      // Pin for the chosen date AND set it as the persistent "current" match
      // (stays the active game across days until replaced — ideal for knockouts).
      // Also record it in the match history (ZSET, newest-first, self-deduping by
      // matchId) with a full snapshot, so the admin can later pick it from a
      // dropdown instead of typing the matchId — including matches that are no
      // longer "current" because a newer one replaced them.
      await kv([
        ['SET', `1x2:override:${date}`, JSON.stringify(match)],
        ['SET', '1x2:current', JSON.stringify(match)],
        ['ZADD', '1x2:history', String(Date.now()), match.matchId],
        ['SET', `1x2:matchmeta:${match.matchId}`, JSON.stringify(match)],
      ]);
      return res.status(200).json({ ok: true, match });
    }

    if (action === 'clearMatch') {
      if (!body.date) return res.status(400).json({ error: 'date required' });
      await kv([['DEL', `1x2:override:${body.date}`], ['DEL', '1x2:current']]);
      return res.status(200).json({ ok: true });
    }

    // One-off repair: overwrite a match's stored label (home/away/group/stage)
    // without touching its predictions/result/points. Needed for matches set up
    // before matchIds included the matchup (a second same-day match used to
    // collide with the first one's id and overwrite its metadata) — the graded
    // data under that id is untouched, only its display label was ever wrong.
    // Uses updateMatchMeta (a plain merge) rather than rebuilding the whole
    // object, so it can never clobber bonusMode/customBonus.
    if (action === 'fixMatchMeta') {
      const { matchId, home, away, group, stage } = body;
      if (!matchId || !home || !home.name || !away || !away.name) {
        return res.status(400).json({ error: 'matchId, home{name}, away{name} required' });
      }
      const [existingRaw] = await kv([['GET', `1x2:matchmeta:${matchId}`]]);
      let existing = {};
      try { existing = existingRaw ? JSON.parse(existingRaw) : {}; } catch (_) {}
      const updated = await updateMatchMeta(matchId, {
        home, away, group: group || '', stage: stage || existing.stage || 'knockout',
      });
      return res.status(200).json({ ok: true, match: withBonus(updated) });
    }

    // Author (or revert) a match's bonus questions. "standard" reverts to the
    // usual 5 generic questions (regenerated fresh on every read, same as
    // before); "custom" replaces them with exactly 5 match-specific ones,
    // persisted verbatim and never silently regenerated (see withBonus in
    // _wc.js) — always 1 p each, so every match still maxes at 10 p regardless
    // of mode. Locked once anyone has already predicted the match: editing a
    // question after even one bet is in would silently grade that player
    // against a question they never actually saw.
    if (action === 'setBonusQuestions') {
      const { matchId, mode } = body;
      if (!matchId) return res.status(400).json({ error: 'matchId required' });
      if (mode !== 'standard' && mode !== 'custom') {
        return res.status(400).json({ error: 'mode must be "standard" or "custom"' });
      }
      if (await matchHasPredictions(matchId)) {
        return res.status(409).json({ error: 'Minst en spelare har redan tippat matchen — bonusfrågorna är låsta och kan inte ändras.' });
      }
      let patch;
      if (mode === 'standard') {
        patch = { bonusMode: 'standard', customBonus: null };
      } else {
        const v = validateCustomBonusDefs(body.questions);
        if (!v.ok) return res.status(400).json({ error: v.error });
        patch = { bonusMode: 'custom', customBonus: v.defs };
      }
      const updated = await updateMatchMeta(matchId, patch);
      return res.status(200).json({ ok: true, match: withBonus(updated) });
    }

    // Wipe the 1x2 cumulative highscore (and the current match's per-match data).
    if (action === 'resetSeason') {
      const cmds = [['DEL', '1x2:season'], ['DEL', '1x2:names']];
      const cur = await getCurrent();
      if (cur && cur.matchId) {
        const id = cur.matchId;
        cmds.push(['DEL', `1x2:pred:${id}`], ['DEL', `1x2:daily:${id}`], ['DEL', `1x2:applied:${id}`],
                  ['DEL', `1x2:graded:${id}`], ['DEL', `1x2:result:${id}`]);
      }
      await kv(cmds);
      return res.status(200).json({ ok: true, note: 'Topplistan nollställd.' });
    }

    // Fix/set one player's prediction by display name (e.g. a broken/incomplete
    // submission). If the match is already graded, transparently regrades everyone
    // afterwards so the correction is reflected in the standings immediately.
    if (action === 'fixPrediction') {
      const { matchId, playerName } = body;
      const H = Number(body.hs), A = Number(body.as);
      if (!matchId || !playerName || !Number.isInteger(H) || !Number.isInteger(A) || H < 0 || A < 0 || H > 30 || A > 30) {
        return res.status(400).json({ error: 'matchId, playerName + integer hs/as required' });
      }
      // Same rule as a normal submission: every bonus question must be answered,
      // so a corrected tip is never left partial either. Reads the match's OWN
      // bonus defs (not just the currently-active match's) — this section's
      // picker can target any match from history.
      const bonusDefs = await getMatchBonusDefs(matchId);
      const bv = validateBonusAnswers(bonusDefs, body.bonus);
      if (!bv.ok) return res.status(400).json({ error: bv.error });

      // Prefer an ID already tied to this match's prediction, then any existing
      // season identity by that name (so a last-minute manual entry lands on the
      // player's real record instead of orphaning points onto a brand-new id),
      // and only mint a synthetic id if the name has genuinely never been seen.
      const existing = await findPlayerByName(matchId, playerName);
      const globalId = existing ? null : await findAnyPlayerIdByName(playerName);
      const staleManualId = `manual-${playerName.trim().toLowerCase().replace(/\s+/g, '-')}`;
      const playerID = existing ? existing.id : (globalId || staleManualId);
      // If an earlier fix for this exact match+name landed on a synthetic id
      // (the bug this replaces) and has since been merged away, clear its
      // leftover per-match residue *before* any regrade below — otherwise
      // regradeMatch would reverse points against a since-deleted season row
      // and resurrect it with a negative score.
      if (playerID !== staleManualId) {
        await kv([
          ['HDEL', `1x2:pred:${matchId}`, staleManualId],
          ['ZREM', `1x2:daily:${matchId}`, staleManualId],
          ['HDEL', `1x2:applied:${matchId}`, staleManualId],
        ]);
      }
      await setPrediction(matchId, playerID, playerName, H, A, bv.b);

      const existingResult = await getResult(matchId);
      if (existingResult) {
        await regradeMatch(matchId, existingResult);
        return res.status(200).json({ ok: true, regraded: true, note: `${playerName}s tips satt till ${H}–${A} och poängen omräknade.` });
      }
      return res.status(200).json({ ok: true, note: `${playerName}s tips satt till ${H}–${A}.` });
    }

    // Look up a player's currently stored prediction for a match (debug helper).
    if (action === 'getPrediction') {
      const { matchId, playerName } = body;
      if (!matchId || !playerName) return res.status(400).json({ error: 'matchId + playerName required' });
      const found = await findPlayerByName(matchId, playerName);
      return res.status(200).json({ found });
    }

    // Look up one playerID directly, bypassing name search — needed for the merge
    // tool when a target orphan's name mapping was already deleted by an earlier
    // merge, so it can no longer be found by searching a name at all.
    if (action === 'getPlayerByID') {
      const { playerID } = body;
      if (!playerID) return res.status(400).json({ error: 'playerID required' });
      const [name, score] = await kv([
        ['HGET', '1x2:names', playerID],
        ['ZSCORE', '1x2:season', playerID],
      ]);
      return res.status(200).json({ playerID, name: name || null, points: Number(score) || 0 });
    }

    // Every player who has ever appeared (any game), alphabetically — powers the
    // "pick a player" dropdown in section 3.
    if (action === 'listPlayers') {
      const [namesRaw] = await kv([['HGETALL', '1x2:names']]);
      const namesObj = hashToObj(namesRaw);
      const players = Object.entries(namesObj)
        .map(([playerID, name]) => ({ playerID, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      return res.status(200).json({ players });
    }

    // Find every playerID currently displaying a given (case-insensitive) name,
    // with their season points — surfaces duplicate identities (e.g. someone had
    // to sign in again after their browser lost its stored player, splitting their
    // score across two rows) so they can be reviewed before merging.
    if (action === 'findPlayersByName') {
      const { name } = body;
      if (!name) return res.status(400).json({ error: 'name required' });
      const [namesRaw] = await kv([['HGETALL', '1x2:names']]);
      const namesObj = hashToObj(namesRaw);
      const needle = String(name).trim().toLowerCase();
      const ids = Object.keys(namesObj).filter((id) => String(namesObj[id]).trim().toLowerCase() === needle);
      if (!ids.length) return res.status(200).json({ players: [] });
      const scores = await kv(ids.map((id) => ['ZSCORE', '1x2:season', id]));
      const players = ids
        .map((id, i) => ({ playerID: id, name: namesObj[id], points: Number(scores[i]) || 0 }))
        .sort((a, b) => b.points - a.points);
      return res.status(200).json({ players });
    }

    // Merge one or more duplicate playerIDs' season points into a single target
    // playerID. Sums 1x2:season into the target, removes the source rows from the
    // leaderboard, and drops their now-orphaned name mapping. Also reassigns every
    // match's per-match records (predictions, that match's points, its applied
    // ledger) from the source ids to the target — without this, old matches keep
    // pointing at the now-nameless source id (shows "Anonym" in Vännernas Tips)
    // and a future regrade would reverse points against a since-deleted season
    // row, resurrecting it with a negative score. If the currently-graded match
    // was affected, its frozen "Snacket" line is regenerated too, since it may
    // now be describing a standing that no longer matches reality. Optional
    // newName covers the case where the surviving id's own display name isn't
    // the one you want going forward (e.g. keeping someone's currently-active
    // browser identity but relabeling it).
    if (action === 'mergePlayers') {
      const { targetPlayerID, sourcePlayerIDs, newName } = body;
      if (!targetPlayerID || !Array.isArray(sourcePlayerIDs) || !sourcePlayerIDs.length) {
        return res.status(400).json({ error: 'targetPlayerID + sourcePlayerIDs[] required' });
      }
      const ids = sourcePlayerIDs.filter((id) => id && id !== targetPlayerID);
      if (!ids.length) return res.status(400).json({ error: 'no valid source ids' });
      const scores = await kv(ids.map((id) => ['ZSCORE', '1x2:season', id]));
      const totalToAdd = scores.reduce((sum, s) => sum + (Number(s) || 0), 0);
      const cmds = [];
      if (totalToAdd !== 0) cmds.push(['ZINCRBY', '1x2:season', String(totalToAdd), targetPlayerID]);
      ids.forEach((id) => { cmds.push(['ZREM', '1x2:season', id], ['HDEL', '1x2:names', id]); });
      if (newName && newName.trim()) cmds.push(['HSET', '1x2:names', targetPlayerID, newName.trim().slice(0, 20)]);
      await kv(cmds);

      const affectedMatchIds = await reassignPlayerAcrossMatches(ids, targetPlayerID);
      const cur = await getCurrent();
      if (cur && cur.matchId && affectedMatchIds.includes(cur.matchId)) {
        try { await regenerateCommentary(cur.matchId); } catch (_) {}
      }

      return res.status(200).json({ ok: true, merged: ids.length, pointsAdded: totalToAdd, renamedTo: newName || null });
    }

    // Enter / correct a final result (incl. bonus answers) and grade.
    if (action === 'setResult' || action === 'regrade') {
      const { matchId } = body;
      const H = Number(body.hs), A = Number(body.as);
      if (!matchId || !Number.isInteger(H) || !Number.isInteger(A) || H < 0 || A < 0 || H > 30 || A > 30) {
        return res.status(400).json({ error: 'matchId + integer hs/as required' });
      }
      // Pull this match's OWN bonus definitions (not just the currently-active
      // match's — this section's picker can grade any match from history) so
      // the answers can be graded. Partial facit entry is allowed
      // (requireAll=false) — stats may trickle in before grading.
      const bonusDefs = await getMatchBonusDefs(matchId);
      const bv = validateBonusAnswers(bonusDefs, body.bonus, false);
      if (!bv.ok) return res.status(400).json({ error: bv.error });
      const result = { hs: H, as: A, b: bv.b, bonusDefs };

      if (action === 'regrade') {
        await regradeMatch(matchId, result);
        return res.status(200).json({ ok: true, regraded: true, note: 'Poäng omräknade.' });
      }
      const graded = await gradeMatch(matchId, result);
      return res.status(200).json({
        ok: true, graded,
        note: graded ? 'Resultat sparat och poäng utdelade.' : 'Redan rättad — använd "Rätta om" för att ändra.',
      });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'admin failed', detail: String((e && e.message) || e) });
  }
};
