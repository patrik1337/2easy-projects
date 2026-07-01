const {
  kv, kvReady, getData, normalizeFeedMatch, gradeMatch, regradeMatch,
  venueDateStr, kickoffMs, buildBonus, getCurrent, getResult,
  setPrediction, findPlayerByName, validateBonusAnswers, hashToObj,
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
        match = {
          matchId: `c-${date}`, dateStr: date, kickoffMs: Number.isFinite(koMs) ? koMs : null,
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
      await kv([
        ['SET', `1x2:override:${date}`, JSON.stringify(match)],
        ['SET', '1x2:current', JSON.stringify(match)],
      ]);
      return res.status(200).json({ ok: true, match });
    }

    if (action === 'clearMatch') {
      if (!body.date) return res.status(400).json({ error: 'date required' });
      await kv([['DEL', `1x2:override:${body.date}`], ['DEL', '1x2:current']]);
      return res.status(200).json({ ok: true });
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
      // so a corrected tip is never left partial either.
      const cur = await getCurrent();
      const bonusDefs = (cur && cur.matchId === matchId && Array.isArray(cur.bonus)) ? cur.bonus : [];
      const bv = validateBonusAnswers(bonusDefs, body.bonus);
      if (!bv.ok) return res.status(400).json({ error: bv.error });

      const existing = await findPlayerByName(matchId, playerName);
      const playerID = existing ? existing.id : `manual-${playerName.trim().toLowerCase().replace(/\s+/g, '-')}`;
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
    // leaderboard, and drops their now-orphaned name mapping. Historical per-match
    // prediction records (tied to the old ids) are left as-is — only the ongoing
    // season total is consolidated.
    if (action === 'mergePlayers') {
      const { targetPlayerID, sourcePlayerIDs } = body;
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
      await kv(cmds);
      return res.status(200).json({ ok: true, merged: ids.length, pointsAdded: totalToAdd });
    }

    // Enter / correct a final result (incl. bonus answers) and grade.
    if (action === 'setResult' || action === 'regrade') {
      const { matchId } = body;
      const H = Number(body.hs), A = Number(body.as);
      if (!matchId || !Number.isInteger(H) || !Number.isInteger(A) || H < 0 || A < 0 || H > 30 || A > 30) {
        return res.status(400).json({ error: 'matchId + integer hs/as required' });
      }
      // Pull this match's bonus definitions so the answers can be graded. Partial
      // facit entry is allowed (requireAll=false) — stats may trickle in before grading.
      const cur = await getCurrent();
      const bonusDefs = (cur && cur.matchId === matchId && Array.isArray(cur.bonus)) ? cur.bonus : [];
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
