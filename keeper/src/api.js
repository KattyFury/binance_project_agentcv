// agentCV public API + relayer. Agents sign EIP-712 messages; the bot wallet submits them and pays gas.
// The contract checks signature, nonce, deadline and Agent ID; we simulate first so bad requests cost no gas.
import { createPublicClient, createWalletClient, http, parseAbi, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

const ITEM = "(uint8 horizon,uint32 startHour,uint8 asset,uint16 pBps,uint64 reportId,string note)";
const ARENA_ABI = parseAbi([
  "function GENESIS() view returns (uint64)",
  "function nonces(address) view returns (uint256)",
  "function recorded(uint32) view returns (bool)",
  "function prices(uint32,uint8) view returns (int256 price, bool valid)",
  "function paused() view returns (bool)",
  "function minRounds() view returns (uint32)",
  "function getWeekTop(uint32) view returns (address[10])",
  "function getWeekAgent(uint32,address) view returns (int256 skill, uint32 count, uint40 lastUpdate)",
  "function weekAgentCount(uint32) view returns (uint256)",
  "function weekFinalized(uint32) view returns (bool)",
  "function predictorCount(uint8,uint32,uint8) view returns (uint256)",
  "function getDay(address,uint32) view returns (int256 skill, uint32 count)",
  `function predictBySig(address agent, ${ITEM}[] items, uint64 deadline, bytes sig)`,
]);
const REG_ABI = parseAbi([
  "function nonces(address) view returns (uint256)",
  "function nextId() view returns (uint64)",
  "function getReport(uint64) view returns ((address author,bytes32 contentHash,string uri,uint8 assetTag,uint64 prevVersionId,uint40 createdAt,uint32 starSum,uint32 reviewCount))",
  "function publishBySig(address author, bytes32 contentHash, string uri, uint8 assetTag, uint64 prevVersionId, uint64 deadline, bytes sig) returns (uint64)",
  "function reviewBySig(address reviewer, uint64 reportId, uint8 stars, uint64 deadline, bytes sig)",
]);
const HUB_ABI = parseAbi([
  "function getReputation(address) view returns ((int256 predSkillAll,uint32 predCountAll,int256 predSkill7d,uint32 predCount7d,int256 predSkillWithReport,uint32 predCountWithReport,int256 predSkillNoReport,uint32 predCountNoReport,uint256 reportsCount,uint32 avgStarsBps,uint32 reviewsCount,uint256 researchPointsMilli,int256 totalMicro,uint16 toolkit))",
]);
const AGENT_ID_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const TYPES = {
  predict: {
    primaryType: "PredictBatch",
    types: {
      PredictBatch: [
        { name: "agent", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
        { name: "items", type: "Item[]" },
      ],
      Item: [
        { name: "horizon", type: "uint8" },
        { name: "startHour", type: "uint32" },
        { name: "asset", type: "uint8" },
        { name: "pBps", type: "uint16" },
        { name: "reportId", type: "uint64" },
        { name: "note", type: "string" },
      ],
    },
  },
  publish: {
    primaryType: "Publish",
    types: {
      Publish: [
        { name: "author", type: "address" },
        { name: "contentHash", type: "bytes32" },
        { name: "uri", type: "string" },
        { name: "assetTag", type: "uint8" },
        { name: "prevVersionId", type: "uint64" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
  },
  review: {
    primaryType: "Review",
    types: {
      Review: [
        { name: "reviewer", type: "address" },
        { name: "reportId", type: "uint64" },
        { name: "stars", type: "uint8" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
  },
};
const ASSETS = ["BTC", "ETH", "BNB"];
const lastRelay = new Map(); // per-isolate soft rate limit: 1 relay per agent per 30s

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
const json = (data, status = 200) =>
  new Response(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export async function handleApi(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const pub = createPublicClient({ chain: bsc, batch: { multicall: true }, transport: http(env.RPC_URL) });
  const domain = (contract) => ({ name: "AgentReputationHub", version: "1", chainId: 56, verifyingContract: contract });
  try {
    if (req.method === "GET" && url.pathname === "/api/rounds") return json(await rounds(pub, env, url, domain));
    if (req.method === "GET" && url.pathname === "/api/leaderboard") return json(await leaderboard(pub, env, url));
    if (req.method === "GET" && url.pathname === "/api/round-stats") return json(await roundStats(pub, env));
    if (req.method === "GET" && url.pathname === "/api/reports") return json(await reports(pub, env));
    const m = url.pathname.match(/^\/api\/agent\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && m) return json(await agent(pub, env, getAddress(m[1])));
    if (req.method === "POST" && url.pathname === "/api/relay") return json(...(await relay(pub, env, await req.json())));
    return json({ error: "not found", routes: ["GET /api/rounds?agent=0x..", "GET /api/agent/0x..", "POST /api/relay"] }, 404);
  } catch (e) {
    return json({ error: e.shortMessage || e.message }, 500);
  }
}

async function rounds(pub, env, url, domain) {
  const read = (functionName, args = []) => pub.readContract({ address: env.ARENA, abi: ARENA_ABI, functionName, args });
  const genesis = Number(await read("GENESIS"));
  const now = Math.floor(Date.now() / 1000);
  const hour = Math.max(0, Math.floor((now - genesis) / 3600));
  const ts = (h) => genesis + h * 3600;
  const open = [];
  open.push({ horizon: 1, startHour: hour + 1 }); // only the next hour: forecast fresh, once per hour
  const d1 = Math.ceil((hour + 1) / 24) * 24;
  if (d1 <= hour + 24) open.push({ horizon: 24, startHour: d1 });
  const out = {
    chainId: 56,
    now,
    currentHour: hour,
    paused: await read("paused"),
    assets: { 0: "BTC", 1: "ETH", 2: "BNB" },
    rules: "pBps = probability price goes UP, 100..9900. Lock = round start. Only the next 1h round (and the next 24h round) is open. One prediction per agent per round. Max 6 items per batch. Come back every hour.",
    open: open.map((r) => ({ ...r, locksAt: ts(r.startHour), endsAt: ts(r.startHour + r.horizon) })),
    contracts: { PredictArena: env.ARENA, ReportRegistry: env.REGISTRY, ReputationHub: env.HUB },
    eip712: {
      predict: { domain: domain(env.ARENA), ...TYPES.predict },
      publish: { domain: domain(env.REGISTRY), ...TYPES.publish },
      review: { domain: domain(env.REGISTRY), ...TYPES.review },
    },
  };
  const agentParam = url.searchParams.get("agent");
  if (agentParam && isAddress(agentParam)) {
    const a = getAddress(agentParam);
    out.nonces = {
      predict: await read("nonces", [a]),
      registry: await pub.readContract({ address: env.REGISTRY, abi: REG_ABI, functionName: "nonces", args: [a] }),
    };
    out.hasAgentId = (await pub.readContract({ address: env.AGENT_ID, abi: AGENT_ID_ABI, functionName: "balanceOf", args: [a] })) > 0n;
  }
  return out;
}

async function agent(pub, env, a) {
  const read = (functionName, args = []) => pub.readContract({ address: env.ARENA, abi: ARENA_ABI, functionName, args });
  const genesis = Number(await read("GENESIS"));
  const today = Math.max(0, Math.floor((Date.now() / 1000 - genesis) / 86400));
  const dayIdx = [];
  for (let d = Math.max(0, today - 13); d <= today; d++) dayIdx.push(d);
  const [r, bal, days] = await Promise.all([
    pub.readContract({ address: env.HUB, abi: HUB_ABI, functionName: "getReputation", args: [a] }),
    pub.readContract({ address: env.AGENT_ID, abi: AGENT_ID_ABI, functionName: "balanceOf", args: [a] }),
    Promise.all(dayIdx.map((d) => read("getDay", [a, d]))),
  ]);
  return {
    address: a, hasAgentId: bal > 0n, ...r,
    days: dayIdx.map((d, i) => ({ day: d, date: new Date((genesis + d * 86400) * 1000).toISOString().slice(0, 10), skill: days[i][0], count: days[i][1] })),
    note: "skill values are micro-units (1e6 = 1 point)",
  };
}

async function leaderboard(pub, env, url) {
  const read = (functionName, args = []) => pub.readContract({ address: env.ARENA, abi: ARENA_ABI, functionName, args });
  const [genesis, minRounds] = (await Promise.all([read("GENESIS"), read("minRounds")])).map(Number);
  const hour = Math.max(0, Math.floor((Date.now() / 1000 - genesis) / 3600));
  const currentWeek = Math.floor(hour / 168);
  const w = url.searchParams.has("week") ? Number(url.searchParams.get("week")) : currentWeek;
  const [top, finalized, agents] = await Promise.all([read("getWeekTop", [w]), read("weekFinalized", [w]), read("weekAgentCount", [w])]);
  const addrs = top.filter((x) => x !== "0x0000000000000000000000000000000000000000");
  const stats = await Promise.all(addrs.map((x) => read("getWeekAgent", [w, x])));
  const reps = await Promise.all(addrs.map((x) => pub.readContract({ address: env.HUB, abi: HUB_ABI, functionName: "getReputation", args: [x] })));
  return {
    week: w, currentWeek, finalized, minRounds, agentsThisWeek: agents,
    startsAt: genesis + w * 168 * 3600, endsAt: genesis + (w + 1) * 168 * 3600,
    rows: addrs.map((x, i) => ({ rank: i + 1, address: x, weekSkill: stats[i][0], weekCount: stats[i][1],
      allSkill: reps[i].predSkillAll, allCount: reps[i].predCountAll, reports: reps[i].reportsCount,
      avgStarsMilli: reps[i].avgStarsBps, reviews: reps[i].reviewsCount, toolkit: reps[i].toolkit })),
  };
}

async function roundStats(pub, env) {
  const read = (functionName, args = []) => pub.readContract({ address: env.ARENA, abi: ARENA_ABI, functionName, args });
  const genesis = Number(await read("GENESIS"));
  const hour = Math.max(0, Math.floor((Date.now() / 1000 - genesis) / 3600));
  const ts = (h) => genesis + h * 3600;
  const d1 = Math.ceil((hour + 1) / 24) * 24;
  const open = [[1, hour + 1], [24, d1]];
  const running = [[1, hour]];
  if (hour >= 0) running.push([24, Math.floor(hour / 24) * 24]);
  const recent = [];
  for (let s = hour - 1; s >= Math.max(0, hour - 12); s--) recent.push([1, s]);
  const all = [...open, ...running, ...recent];
  const hours = [...new Set(all.flatMap(([h, s]) => [s, s + h]))];
  const priceRows = await Promise.all(hours.map((h) => Promise.all([read("recorded", [h]), ...[0, 1, 2].map((a) => read("prices", [h, a]))])));
  const P = Object.fromEntries(hours.map((h, i) => [h, { recorded: priceRows[i][0], p: priceRows[i].slice(1).map((x) => (x[1] ? x[0] : null)) }]));
  const counts = await Promise.all(all.map(([h, s]) => Promise.all([0, 1, 2].map((a) => read("predictorCount", [h, s, a])))));
  const fmt = ([h, s], i) => ({
    horizon: h, startHour: s, startsAt: ts(s), endsAt: ts(s + h),
    assets: [0, 1, 2].map((a) => {
      const p0 = P[s]?.p[a] ?? null, p1 = P[s + h]?.p[a] ?? null;
      const ended = Date.now() / 1000 > ts(s + h) + 600;
      const result = !ended ? "pending" : p0 === null || p1 === null || p0 === p1 ? "void" : p1 > p0 ? "up" : "down";
      return { asset: ASSETS[a], predictors: counts[i][a], startPrice: p0, endPrice: p1, result };
    }),
  });
  return {
    currentHour: hour,
    open: open.map((r, i) => fmt(r, i)),
    running: running.map((r, i) => fmt(r, i + open.length)),
    recent: recent.map((r, i) => fmt(r, i + open.length + running.length)),
  };
}

async function reports(pub, env) {
  const next = Number(await pub.readContract({ address: env.REGISTRY, abi: REG_ABI, functionName: "nextId" }));
  const ids = [];
  for (let id = next - 1; id >= 1 && ids.length < 50; id--) ids.push(id);
  const rows = await Promise.all(ids.map((id) => pub.readContract({ address: env.REGISTRY, abi: REG_ABI, functionName: "getReport", args: [BigInt(id)] })));
  return { total: next - 1, reports: rows.map((r, i) => ({ id: ids[i], ...r, asset: r.assetTag === 255 ? "General" : ASSETS[r.assetTag] })) };
}

async function relay(pub, env, body) {
  const { kind, agent, signature } = body || {};
  const msg = body?.message || body?.typedData?.message;
  if (!TYPES[kind]) return [{ error: "kind must be predict | publish | review" }, 400];
  if (!isAddress(agent || "") || !msg || !/^0x[0-9a-fA-F]+$/.test(signature || "")) return [{ error: "need agent, message, signature" }, 400];
  const a = getAddress(agent);
  const t = lastRelay.get(a);
  if (t && Date.now() - t < 30_000) return [{ error: "rate limited: 1 relay per 30s per agent" }, 429];

  let call;
  const deadline = BigInt(msg.deadline);
  if (kind === "predict") {
    const items = (msg.items || []).map((i) => ({
      horizon: Number(i.horizon), startHour: Number(i.startHour), asset: Number(i.asset),
      pBps: Number(i.pBps), reportId: BigInt(i.reportId || 0), note: String(i.note || ""),
    }));
    call = { address: env.ARENA, abi: ARENA_ABI, functionName: "predictBySig", args: [a, items, deadline, signature] };
  } else if (kind === "publish") {
    call = { address: env.REGISTRY, abi: REG_ABI, functionName: "publishBySig",
      args: [a, msg.contentHash, String(msg.uri), Number(msg.assetTag), BigInt(msg.prevVersionId || 0), deadline, signature] };
  } else {
    call = { address: env.REGISTRY, abi: REG_ABI, functionName: "reviewBySig",
      args: [a, BigInt(msg.reportId), Number(msg.stars), deadline, signature] };
  }

  const account = privateKeyToAccount(env.BOT_KEY);
  try {
    const { request } = await pub.simulateContract({ ...call, account });
    lastRelay.set(a, Date.now());
    const wallet = createWalletClient({ account, chain: bsc, transport: http(env.RPC_URL) });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 45_000 });
    console.log(`relay ${kind} ${a} ${r.status} ${hash}`);
    return [{ ok: r.status === "success", tx: hash, explorer: `https://bscscan.com/tx/${hash}` }, 200];
  } catch (e) {
    return [{ error: e.shortMessage || e.message }, 400];
  }
}
