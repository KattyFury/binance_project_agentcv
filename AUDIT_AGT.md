# Technical audit: agentCV → AGT (Agent Got Talent)

Date: 2026-11-22. Scope: audit only, no code changes.
Tags used below: **[V]** verified in code or on-chain, **[A]** assumption that has not been verified, **[R]** recommendation.

---

## 1. Current architecture

### 1.1 Repository (commit `3eaef13`)

| Path | What it is |
|---|---|
| `contracts/PredictArena.sol` (418 lines) | Forecasting contest, scoring, weekly top 10 |
| `contracts/ReportRegistry.sol` | Research reports (content hash + URI) and 1–5 star reviews |
| `contracts/ReputationHub.sol` | Stateless view that aggregates the two contracts above |
| `contracts/ReputationGate.sol` | Sample consumer: `enter()` only if the Hub score is at least a threshold |
| `contracts/mocks/` | MockAgentId (ERC-721), MockFeed (Chainlink-like) |
| `test/Hub.test.js` | 29 Hardhat tests, all passing **[V]** |
| `keeper/src/index.js` | Cloudflare Worker cron (every 5 min): record prices, settle, finalize the week |
| `keeper/src/api.js` | Public read API and EIP-712 relayer (`/api/rounds`, `/api/agent/:a`, `/api/leaderboard`, `/api/round-stats`, `/api/reports`, `POST /api/relay`) |
| `keeper/public/` | Static read-only web app (5 views), served by the same Worker |
| `scripts/deploy-web.js`, `deploy-web/` | Local page so the owner deploys by signing in their own wallet (no key in the repo) |

Stack: Solidity 0.8.24, OpenZeppelin 5.0.2 (EIP712, SignatureChecker, Ownable, Pausable), Hardhat, viem in the Worker, Cloudflare Workers with static assets. **There is no database, KV store or event indexer.** **[V]**

### 1.2 Deployed: BNB Chain mainnet, trial (`deployments/bsc-trial.json`) [V]

| Contract | Address |
|---|---|
| ReportRegistry | `0x541F33A4426BE4AE8CbfeC1d8657D8a45d6780c1` |
| PredictArena | `0x08894b6E782fD65587F2c02e1617f0e9FcDc16F5` |
| ReputationHub | `0x6af07502B3bFC2F270504c752cF8949F937fBfd1` |
| ReputationGate | `0x91291eB5E0E3891521e8803f1f0452EA0C3ffEd6` |

- **Owner and settings:** owner is `0x450d…A0a4`. Feeds lock at unix `1795369824` (2026-11-22, about 17:50 UTC). Genesis is `1795280400`, `minRounds` is 10. None of the contracts are verified on BscScan yet.
- **The deployed bytecode is older than the repo.** On-chain `MAX_AHEAD_H1 = 6` and `MAX_BATCH = 18`. The repo now has 1 and 6, so it no longer matches what is deployed.
- **The keeper is live.** It recorded hours 1 and 2.
- **One real end-to-end relay has succeeded.** In tx `0x0031…2616`, an agent in Binance AI Pro, using wallet `0xe0a3…4Ca2`, signed EIP-712 and the relayer submitted 18 forecasts. Details:
  - That wallet holds an Agent ID (balance 1).
  - The wallet is an EOA (no contract code), and the signature is 65 bytes, so this is plain ECDSA.
  - Gas used was 1,532,038, which cost 0.0000766 BNB.
- **The Agent ID contract** `0x60b9…022f` reports ERC-721 support (`supportsInterface` true). It does **not** support the Enumerable extension, so there is no on-chain way to list holders.

### 1.3 Data flow [V]

1. The agent calls `GET /api/rounds?agent=` and gets the open rounds, the EIP-712 domain and types, and its nonces.
2. The agent signs a `PredictBatch`.
3. `POST /api/relay` sends it. The Worker first simulates the call (`simulateContract`), then sends it from the bot wallet.
4. The keeper calls `recordPrices(hour)` within 10 minutes after each hour, then `settle(...)` in chunks of 50, then `finalizeWeek`.
5. The web app reads everything through the API, which uses multicall.

---

## 2. Answers to the audit questions

### Q3. Does PredictArena support multiple independent tournaments? **No.** [V]

- A round is identified only by `keccak256(horizon, startHour, asset)`. There is no tournament ID anywhere.
- The assets are fixed: `IAggregator[3] feeds`, checked with `asset < 3`. The feeds can only be replaced in the first 24 hours after deployment.
- There is one global `GENESIS`, one global week index (`startHour / 168`) and one global `minRounds`. Totals, daily buckets and the weekly top 10 are all global per agent.
- Rounds can only be 1 hour or 24 hours long, and outcomes can only be "up" or "down" versus the start price.
- **Conclusion:** supporting tournaments needs a **new contract**, not a patch. The scoring function `_skillMicro`, the chunked settlement loop and the top-10 insertion logic can be copied over.

### Q4. Can the EIP-712 batch submission be reused safely? **The pattern yes; the type no.** [V] / [R]

**Verified:**
- The domain is bound to `chainId` and `verifyingContract` (OZ `EIP712`).
- Each agent has one sequential nonce per contract, and every message has a deadline.
- `SignatureChecker` accepts both ECDSA and ERC-1271 wallets.
- A real Binance AI Pro agent produced a valid signature.
- The relayer cannot forge or change a batch: the items are hashed into the signature.

**Problems to fix in the new type:**
1. **The new `Entry` type must include `tournamentId` and `questionId`.** Otherwise a signature could be applied to the wrong tournament.
2. **Sequential nonces serialize an agent.** If two signed batches are in flight, the one with the higher nonce fails until the lower one lands. **[R]** Either use unordered nonces (a bitmap, as in Permit2), or keep sequential nonces and tell agents to sign one batch per call.
3. **The relayer can censor.** It can hold back a batch until after the lock time. The direct `predict()` path is the fallback. **[R]** Keep both paths.
4. **Forecasts are public before the round locks.** `Predicted` emits `pBps` as soon as a forecast is submitted, so late agents can copy earlier ones. **[R]** For V1, accept this and show the risk. Commit-reveal would fix it, but it doubles the number of signatures each user must approve.
5. **Consent:** each signature is approved by the user inside Binance AI Pro. This was observed once, through the user's own report. Any design that auto-signs on a schedule would break that consent.

### Q5. Minimal tournament data model [R]

```
Tournament { id, organizer, specHash, specURI, status(Draft|Published|Closed|Finalized),
             startsAt, endsAt, minEntries, rewardNote (text only, no custody) }
Question   { id, tournamentId, kind(Binary), opensAt, locksAt, resolvesAt,
             resolver(Oracle|Attested), oracleParams | attestParams, outcome(Unset|Yes|No|Void) }
Entry      { questionId, agent -> pBps (100..9900), noteHash }
AgentStats { joined[tournamentId], entries, settled, skillSum, missed }   // reputation inputs
```

- **One question type for V1:** binary, scored with a probability, reusing the existing scoring formula. Numeric and ranking questions go to V2.
- **The full tournament spec is a JSON file stored off-chain.** It holds the prompt, the rules text, the template ID and its parameters. On-chain only `specHash` is stored, so nobody can change the rules after publication.
- **Daily average:** average skill per tournament day equals the sum of skill divided by the number of settled entries that day. This is computed in the view or API, not stored.

### Q6. Oracle vs authoritative web source without AI judging [R]

- **Oracle questions (trustless):** "Will BTC/USD on Chainlink be above X at time T?" or "Will it be higher at T2 than at T1?".
  - The feed address is checked against an allowlist of Chainlink feeds on BNB Chain.
  - Anyone can resolve the question inside a time window.
  - The existing `recordPrices` window logic and the staleness check (`STALE_AFTER`) can be reused **[V]**.
  - Optional upgrade: resolve from a specific Chainlink `getRoundData(roundId)` with a proof that the round is the first one at or after T. This removes the 10-minute recording window. **[A]** Feed round IDs and phase handling need testing.
- **Authoritative web-source questions (trusted, but transparent):** these **cannot be verified trustlessly on-chain**. Honest V1 design:
  - The spec fixes the source URL and the exact resolution rule before publication; both are in `specHash`.
  - A named resolver (the organizer, or an AGT resolver key) posts the outcome, the evidence URL and the evidence content hash.
  - Optional challenge window (for example 24h), during which Agent ID holders can flag the result. In V1 a flag only marks the result as "contested" on the website; there is no dispute process.
  - The UI must label these questions as **"Resolved by <resolver>"**, never as "verified".
- **Third-party oracles:** UMA Optimistic Oracle and Chainlink Functions would make web resolution less trust-based. **[A]** Whether either is available on BNB Chain mainnet has **not been checked**, and integrating one before 12-07 is high risk. Defer.
- **Where AI is allowed:** only in **proposal**. The LLM turns the organizer's request into a filled template, such as a price threshold or a "source publishes value V by date D" question. It never decides an outcome. Requests that don't fit a template are rejected with "not verifiable in V1".

### Q7. Simplest viable reputation [R]

Keep raw counters on-chain (so they can't be tampered with) and compute the three scores in a view function or the API:

| Score | Definition | Inputs |
|---|---|---|
| Performance | Mean skill per settled entry, shrunk toward 0 for small samples, e.g. `skillSum / (settled + 10)` | `skillSum`, `settled` |
| Reliability | Share of questions answered in tournaments the agent joined: `entries / questions_open_while_joined` | Needs an on-chain `join(tournamentId)` (one signed action) and the per-tournament question count |
| Experience | Settled entries plus tournaments completed | Counters |

- No weighted reputation across organizers in V1.
- Drop the report stars from the headline score. The research and review features can stay as a side feature, or be cut.

### Q8. Security risks, rule conflicts, blockers

**Critical: needs an answer from the organizers before building**

1. **Counting rule.** Relayed transactions all have `tx.from` = the relayer. If organizers count "Agent IDs interacting with the contract" by transaction sender, the relayer path counts as **one** address. **[A]** We have not confirmed how they count; this is assumption #4 in the original spec, still open. Mitigations:
   - ask the organizers;
   - make the direct `predict()` / `enter()` path the default (each agent then needs a small amount of BNB for gas);
   - give judges a list of event-indexed signer addresses as evidence.
2. **Signing friction vs consent.** Every signature must be confirmed by the user, so "agents compete every hour" means a human taps approve every hour. **[R]** Design tournaments as **one signature per day or per tournament**: one batch that covers all questions of a session, with locks hours apart. Do not add auto-signing.

**High**

3. **Tournament creation is user-generated content.** An organizer prompt could be gambling-like, offensive, or promise profit; red line 7 forbids promising profit. **[R]**
   - Use template-only tournaments, with fixed rules text.
   - Ban phrases like "earn" and "profit" in the reward text.
   - Each organizer approves by signing, which gives an on-chain record of who approved what.
   - Keep the creation rate low (for example 3 per organizer per day).
4. **Organizer-promised rewards are not enforced.** **[R]** Show "Promised by organizer, not guaranteed, not held by AGT". Keep the reward as text only, with no amount field that could look like a pool.
5. **Hot key.** One bot key both relays and runs the keeper. It holds about 0.0019 BNB **[V]**. The relayer's rate limit lives in Worker memory only (`lastRelay` Map), so it resets across Worker isolates. There is no daily gas cap **[V]**. **[R]** Split the keys, add a daily spend cap in Durable Objects or KV, and keep the balance low.
6. **Sybil.** The production Agent ID is assumed to be non-transferable (comment in MockAgentId) **[A, not verified on-chain]**. One person could still control several Agent IDs; red line 10 forbids that, but it can't be enforced on-chain.

**Medium**

7. **Infrastructure limits.**
   - The public BSC RPC rate-limits `eth_getLogs` when it is sent in a batch **[V]**, so building history from events needs a paid RPC or our own indexer.
   - The Cloudflare free plan allows 5 cron triggers per account, and 3 are already used by other projects **[V]**.
   - **[R]** Add an indexer: the Worker cron ingests events into D1.
8. **Repo name contains "binance".** Red line 5 bans "Binance/BNB" in the *project name, token, domain*. Whether a repo name counts is unclear. **[R]** Rename the public repo before submission, for example `agt` or `agentgottalent`.
9. **No contracts verified on BscScan yet.** Submission requires verified contracts. Etherscan was down; this is not a code issue.
10. **The product claim is wider than V1.** "Describe the AI talent you need" suggests any skill. V1 can only measure **calibrated forecasting on objectively resolvable questions**. Coding, research or writing talent needs judging, which is V2. The pitch must say this honestly.

---

## 3. Reuse vs rebuild

| Component | Verdict | Notes |
|---|---|---|
| Brier scoring `_skillMicro` | **Reuse as is** | Pure function, tested |
| Chunked settlement loop and cursor | **Reuse (copy)** | Re-key by `questionId` |
| Top-10 insertion with tie-breaks | **Reuse (copy)** | Per tournament instead of per week |
| `recordPrices` window, staleness and void rules | **Reuse (adapt)** | Per question instead of global hours |
| Agent ID gate (`balanceOf > 0`) | **Reuse** | Same address |
| EIP-712 + SignatureChecker + deadline | **Reuse pattern** | New types with tournament and question IDs; consider unordered nonces |
| PredictArena as a contract | **Rebuild** | No tournaments, fixed 3 assets, global week |
| ReportRegistry / reviews | **Defer or drop** | Not needed for AGT V1 |
| ReputationHub | **Rebuild (small)** | New inputs: Performance, Reliability, Experience |
| ReputationGate | **Keep as a demo** | Re-point at the new Hub |
| Keeper Worker | **Adapt** | Iterate open questions instead of hours; same write cap and simulate-first approach |
| Relayer `/api/relay` | **Adapt** | New `kind`s (`join`, `enter`, `approveTournament`, `resolve`) |
| Read API | **Adapt** | Needs tournament endpoints and an event indexer (D1) |
| Web shell, design system, read-only approach | **Reuse** | Change the views: tournaments list and detail, create page, profile |
| Owner-signs-deploy page | **Reuse** | Point it at the new artifacts |
| AI proposal service | **New** | Worker plus LLM call returning a template JSON. The LLM and provider still need choosing; per the owner's rule, these must be approved before any agent code is written |
| Organizer approval flow | **New** | Organizer signs an EIP-712 `Publish(specHash, questions…)`. A wallet signature, not a QR login |

---

## 4. Proposed V1 architecture [R]

```
Organizer (any wallet, or Agent ID holder) ──NL request──► AGT Proposer (Worker + LLM, template-only)
        ◄── draft spec JSON (questions, times, resolver, rules text) ──┘
        ── signs EIP-712 PublishTournament(specHash, questionsHash) ──► Relayer ──► TournamentArena
Agents (Binance AI Pro) ── GET /api/tournaments/:id ── sign Join + EntryBatch ──► Relayer or direct ──► TournamentArena
Keeper (cron) ── resolveOracle(qid) from Chainlink ──► TournamentArena ── settle(qid, n)
Attested resolver ── resolveAttested(qid, outcome, evidenceHash, evidenceURI) ──► TournamentArena
Indexer (cron → D1) ◄── events ── Web (read-only) / API / AgentReputation view
```

**Contracts:**
- **`TournamentArena`:** one contract holding all tournaments. It has no owner powers over results, and only pause for new entries.
- **`AgentReputation`:** a view-only contract.
- No funds anywhere.

---

## 5. Milestones (from 2026-11-22; submit 2026-12-07)

| # | Dates | Deliverable | Verify by |
|---|---|---|---|
| 0 | 11-22 → 11-23 | Ask the organizers about relayed-tx counting; get a BscScan key; rename the repo; owner approves the LLM choice | Written answer from the organizers |
| 1 | 11-23 → 11-26 | `TournamentArena`: create/publish (organizer signature), join, entry batch, oracle resolve, attested resolve, settle, per-tournament top 10, counters | Hardhat tests on a fork with real Chainlink feeds |
| 2 | 11-27 → 11-28 | Keeper and relayer adapted, plus a D1 indexer | Full round on a mainnet trial deploy |
| 3 | 11-28 → 11-30 | Proposer: request → template JSON → preview → organizer signs | 5 sample requests; unverifiable ones rejected |
| 4 | 11-30 → 12-02 | Web: tournament list and detail, create page, agent profile with the 3 scores | Design-system check plus screenshots |
| 5 | 12-01 | Final mainnet deploy, verify on BscScan, publish the repo, update the Join prompt | BscScan shows verified source |
| 6 | 12-02 → 12-06 | Run 2–3 seeded tournaments daily; recruit agents | At least 30 distinct Agent ID signers by 12-05 |
| 7 | 12-07 | Submit | — |

**Effort:**
- About 11–13 developer-days of building, against 15 calendar days. This is tight, and it leaves little time for recruiting.
- Recruiting 30–100 Agent IDs is the real risk, and code doesn't solve it.

---

## 6. Must-have vs defer

**Must-have for V1**
- Multi-tournament contract with binary probability questions.
- Chainlink oracle resolution.
- Organizer approval by signature.
- Agents join and enter through EIP-712, with both relay and direct paths.
- Per-tournament leaderboard.
- Agent profile with Performance, Reliability and Experience.
- A template-only AI proposer.
- Risk banner, BscScan verification, public repo.

**Nice to have, only if time allows**
- Attested web-source questions with a challenge flag. These are one extra resolver type; keep the UI label honest.
- Daily average view.
- Unordered nonces.

**Defer to V2**
- Commit-reveal.
- Numeric and ranking questions.
- UMA or Chainlink Functions.
- Reports and reviews.
- Escrow and on-chain rewards.
- AI judging.
- Hiring marketplace, disputes, FLOP compute.

---

## 7. Go / No-Go

**Conditional GO** for a *narrow* V1: **"tournaments of verifiable forecasting questions"**. AI drafts them from templates, organizers sign to publish, Chainlink resolves them, and Binance Agent IDs compete and build a 3-part reputation. About 70% of the current resolution, scoring and relay logic carries over.

**NO-GO** for the broad claim "any AI talent". Without AI judging, V1 cannot verify skills beyond resolvable forecasts. Pitch it as forecasting talent, the first verifiable skill, and leave other skills for V2.

**Conditions before committing:**
1. The organizers confirm that relayed, signature-based interactions count toward the 30-Agent-ID threshold. If not, switch to direct transactions and plan for gas.
2. Tournament design needs at most **one user signature per day** per agent, otherwise participation will collapse.
3. Owner approval of the LLM and provider for the proposer, per the owner's agent-building rule.
