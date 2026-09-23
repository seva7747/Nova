/**
 * Smoke test for Nova's brain (services/llm.ts), run by hand:
 *
 *   npx tsx backend/src/scripts/smokeBrain.ts
 *
 * Exists because the brain has no other test surface — every other way to
 * exercise it involves a microphone, a live voice session, and a human
 * listening for whether the answer sounded right. This drives
 * runConversationTurn directly instead, and checks the three things that
 * actually break when the underlying model or API changes:
 *
 *   1. HOSTED WEB SEARCH — that the model really searches instead of
 *      answering from training data (this silently regressed to "I can't
 *      check live weather" on a previous provider swap).
 *   2. THE TOOL LOOP — that a local function_call comes back, gets its
 *      function_call_output, and the model then answers from it. This is
 *      where the Responses API's contract (every call needs its output, in
 *      order, with its reasoning item in front of it) actually gets tested;
 *      violating it corrupts a session permanently, so it's worth checking
 *      deliberately rather than discovering mid-conversation.
 *   3. A FOLLOW-UP TURN on the history the first one returned — the API
 *      re-validates every reasoning item and resolved call on the way back
 *      in, so "answers once, throws on the second question" is a real and
 *      easy regression to ship.
 *
 * Uses only static, read-only tools — no Composio connection, no side
 * effects, no reminders or calendar writes. It does spend a few cents of
 * real API credit per run.
 */
import { runConversationTurn } from "../services/llm.js";
import { staticTools } from "../tools/index.js";

const USER_ID = "smoke-test-user";

/** Tools minus the ones that would actually do something to the real world. */
const READ_ONLY_TOOLS = staticTools.filter(
  (t: any) => !["make_phone_call", "set_reminder", "add_calendar_event", "search_gmail"].includes(t.name)
);

async function run(label: string, prompt: string, expect: (out: { finalText: string; messages: any[] }) => string | null) {
  process.stdout.write(`\n▸ ${label}\n  asking: "${prompt}"\n`);
  const started = Date.now();
  try {
    const out = await runConversationTurn({
      messages: [{ role: "user", content: prompt }],
      tools: READ_ONLY_TOOLS,
      userId: USER_ID,
      onSlowTool: async () => {},
    });
    const elapsed = Date.now() - started;
    const calls = (out.messages as any[]).filter((m) => m?.type === "function_call").map((m) => m.name);
    console.log(`  answered in ${elapsed}ms: "${out.finalText}"`);
    console.log(`  local tool calls: ${calls.length ? calls.join(", ") : "(none)"}`);
    const problem = expect(out as any);
    console.log(problem ? `  ✗ FAIL — ${problem}` : "  ✓ pass");
    return !problem;
  } catch (err: any) {
    console.log(`  ✗ FAIL — threw: ${err?.message ?? err}`);
    return false;
  }
}

const results: boolean[] = [];

// 1. Hosted web search. Checked by asking for something that cannot be
// answered from training data at all, then looking for a real number in the
// reply rather than a refusal.
results.push(
  await run("hosted web search", "What's the weather in Campbell, California right now?", ({ finalText }) => {
    if (/can'?t|cannot|unable|don'?t have access|no access/i.test(finalText)) return "model said it couldn't check — web search likely not running";
    if (!/\d/.test(finalText)) return "no number in the answer — doesn't look like a real forecast";
    return null;
  })
);

// 2. The local tool loop, end to end. check_background_tasks is read-only
// and always answerable, so a healthy run MUST call it.
results.push(
  await run("local tool loop", "What are you working on in the background right now?", ({ finalText, messages }) => {
    const called = (messages as any[]).some((m) => m?.type === "function_call" && m.name === "check_background_tasks");
    if (!called) return "never called check_background_tasks";
    const outputs = (messages as any[]).filter((m) => m?.type === "function_call_output");
    const calls = (messages as any[]).filter((m) => m?.type === "function_call");
    if (outputs.length !== calls.length) return `${calls.length} call(s) but ${outputs.length} output(s) — history is not a valid Responses sequence`;
    if (!finalText) return "no spoken answer";
    return null;
  })
);

// 3. A FOLLOW-UP turn on the history the previous turn returned. This is the
// one that quietly breaks: the history now contains reasoning items and
// resolved function calls, and the Responses API validates all of it on the
// way back in. A session that can answer once but throws on the second
// question is the exact failure shape that used to wedge whole conversations.
results.push(
  await (async () => {
    process.stdout.write(`\n▸ follow-up turn on reused history\n`);
    try {
      const first = await runConversationTurn({
        messages: [{ role: "user", content: "What are you working on in the background right now?" }],
        tools: READ_ONLY_TOOLS,
        userId: USER_ID,
        onSlowTool: async () => {},
      });
      const history = first.messages as any[];
      history.push({ role: "user", content: "Okay. And what's the capital of France?" });
      const second = await runConversationTurn({
        messages: history,
        tools: READ_ONLY_TOOLS,
        userId: USER_ID,
        onSlowTool: async () => {},
      });
      console.log(`  first:  "${first.finalText}"`);
      console.log(`  second: "${second.finalText}"`);
      if (!/paris/i.test(second.finalText)) {
        console.log("  ✗ FAIL — follow-up answer doesn't look right");
        return false;
      }
      console.log("  ✓ pass");
      return true;
    } catch (err: any) {
      console.log(`  ✗ FAIL — second turn threw: ${err?.message ?? err}`);
      return false;
    }
  })()
);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed\n`);
process.exit(passed === results.length ? 0 : 1);
