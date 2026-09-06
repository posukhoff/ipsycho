import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProblemSink } from "../../dist/observability/problem-log.js";

const scratch = () => mkdtempSync(join(tmpdir(), "ipsycho-problems-"));

test("without PROBLEM_LOG_FILE nothing is written and nothing throws", () => {
  const sink = createProblemSink({});
  sink.record(JSON.stringify({ event: "AI action rejected" }));
});

test("each warning is one line, appended in order", () => {
  const file = join(scratch(), "problems.jsonl");
  const sink = createProblemSink({ PROBLEM_LOG_FILE: file });
  sink.record(JSON.stringify({ event: "first" }));
  sink.record(JSON.stringify({ event: "second" }));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).event),
    ["first", "second"],
  );
});

test("the directory is created, so a fresh deployment does not have to prepare it", () => {
  const file = join(scratch(), "nested", "deeper", "problems.jsonl");
  createProblemSink({ PROBLEM_LOG_FILE: file }).record(JSON.stringify({ event: "one" }));
  assert.ok(existsSync(file));
});

test("the file rotates once at the cap and keeps exactly one previous generation", () => {
  const file = join(scratch(), "problems.jsonl");
  const sink = createProblemSink({ PROBLEM_LOG_FILE: file, PROBLEM_LOG_MAX_BYTES: "80" });
  for (const event of ["a", "b", "c", "d", "e", "f"]) sink.record(JSON.stringify({ event, pad: "x".repeat(20) }));
  assert.ok(existsSync(`${file}.1`), "the previous generation is kept");
  assert.ok(readFileSync(file, "utf8").length <= 80, "the live file stays under the cap");
  assert.ok(!existsSync(`${file}.2`), "only one generation is kept");
});

test("a file size already on disk counts toward the cap", () => {
  const file = join(scratch(), "problems.jsonl");
  writeFileSync(file, "x".repeat(200));
  createProblemSink({ PROBLEM_LOG_FILE: file, PROBLEM_LOG_MAX_BYTES: "100" }).record(JSON.stringify({ event: "after restart" }));
  assert.equal(readFileSync(`${file}.1`, "utf8").length, 200);
  assert.equal(JSON.parse(readFileSync(file, "utf8").trim()).event, "after restart");
});

test("an unwritable path disables the sink instead of throwing on every turn", () => {
  // A directory where the file should be: every append fails, and the bot must not notice.
  const dir = scratch();
  const sink = createProblemSink({ PROBLEM_LOG_FILE: dir });
  sink.record(JSON.stringify({ event: "one" }));
  sink.record(JSON.stringify({ event: "two" }));
});
