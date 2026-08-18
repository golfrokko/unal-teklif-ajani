import test from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/lib/queue.mjs";

test("aynı işi iki kez kuyruğa almaz ve sırayla çalıştırır", async () => {
  const completed = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const queue = new JobQueue({
    maxActive: 1,
    handler: async (id) => {
      completed.push(id);
      if (completed.length === 2) resolveDone();
    },
  });
  assert.equal(queue.add("a"), true);
  assert.equal(queue.add("a"), false);
  assert.equal(queue.add("b"), true);
  await done;
  assert.deepEqual(completed, ["a", "b"]);
});
