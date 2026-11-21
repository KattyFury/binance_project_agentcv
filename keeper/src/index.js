// agentCV keeper: every hour record prices, settle ended rounds, finalize finished weeks.
// All three calls are permissionless; the bot wallet only pays gas and has no owner rights.
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { handleApi } from "./api.js";

const ABI = parseAbi([
  "function GENESIS() view returns (uint64)",
  "function recorded(uint32) view returns (bool)",
  "function predictorCount(uint8,uint32,uint8) view returns (uint256)",
  "function settleCursor(bytes32) view returns (uint32)",
  "function roundKey(uint8,uint32,uint8) pure returns (bytes32)",
  "function weekFinalized(uint32) view returns (bool)",
  "function recordPrices(uint32)",
  "function settle(uint8,uint32,uint8,uint32)",
  "function finalizeWeek(uint32)",
]);
const RECORD_WINDOW = 600; // seconds after the hour, from the contract
const LOOKBACK_H = 24; // re-check H1 rounds that ended in the last 24 hours
const SETTLE_BATCH = 50; // predictions per settle tx
const MAX_WRITES = 6; // stay well under the Worker subrequest limit

async function run(env) {
  const arena = env.ARENA;
  const pub = createPublicClient({ chain: bsc, transport: http(env.RPC_URL, { batch: true }) });
  const account = privateKeyToAccount(env.BOT_KEY);
  const wallet = createWalletClient({ account, chain: bsc, transport: http(env.RPC_URL) });
  const read = (functionName, args = []) => pub.readContract({ address: arena, abi: ABI, functionName, args });
  const log = [];
  let writes = 0;
  const write = async (functionName, args) => {
    if (writes >= MAX_WRITES) return log.push(`skip ${functionName}(${args}) write cap`);
    writes++;
    try {
      const hash = await wallet.writeContract({ address: arena, abi: ABI, functionName, args });
      const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 60_000 });
      log.push(`${functionName}(${args}) ${r.status} ${hash}`);
    } catch (e) {
      log.push(`${functionName}(${args}) failed: ${e.shortMessage || e.message}`);
    }
  };

  const genesis = Number(await read("GENESIS"));
  const now = Math.floor(Date.now() / 1000);
  if (now < genesis) return [`before genesis ${genesis}`];
  const hour = Math.floor((now - genesis) / 3600);

  // 1. record this hour's prices (only valid in the first 10 minutes)
  const inWindow = now - (genesis + hour * 3600) <= RECORD_WINDOW;
  if (inWindow && !(await read("recorded", [hour]))) await write("recordPrices", [hour]);

  // 2. settle ended rounds that still have unsettled predictions
  const rounds = [];
  for (let s = Math.max(0, hour - LOOKBACK_H); s <= hour - 1; s++) rounds.push([1, s]);
  for (let s = Math.max(0, hour - 24 - 24); s <= hour - 24; s++) if (s % 24 === 0) rounds.push([24, s]);
  const items = rounds.flatMap(([h, s]) => [0, 1, 2].map((a) => [h, s, a]));
  const counts = await Promise.all(items.map((it) => read("predictorCount", it)));
  const pending = items.filter((_, i) => counts[i] > 0n);
  const keys = await Promise.all(pending.map((it) => read("roundKey", it)));
  const cursors = await Promise.all(keys.map((k) => read("settleCursor", [k])));
  for (let i = 0; i < pending.length; i++) {
    const total = counts[items.indexOf(pending[i])];
    if (BigInt(cursors[i]) < total) await write("settle", [...pending[i], SETTLE_BATCH]);
  }

  // 3. finalize last week 6 hours after it ends
  const week = Math.floor(hour / 168);
  if (week > 0 && hour >= week * 168 + 6 && !(await read("weekFinalized", [week - 1])))
    await write("finalizeWeek", [week - 1]);

  return [`hour ${hour}`, ...log];
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env).then((l) => console.log(l.join(" | "))));
  },
  // /api/* -> public API + relayer; GET / -> keeper status
  async fetch(req, env) {
    if (new URL(req.url).pathname.startsWith("/api/")) return handleApi(req, env);
    const pub = createPublicClient({ chain: bsc, transport: http(env.RPC_URL) });
    const genesis = Number(await pub.readContract({ address: env.ARENA, abi: ABI, functionName: "GENESIS" }));
    const hour = Math.floor((Date.now() / 1000 - genesis) / 3600);
    const recorded = await pub.readContract({ address: env.ARENA, abi: ABI, functionName: "recorded", args: [hour] });
    const bal = await pub.getBalance({ address: privateKeyToAccount(env.BOT_KEY).address });
    return Response.json({ arena: env.ARENA, hour, recordedThisHour: recorded, botBalanceWei: bal.toString() });
  },
};
