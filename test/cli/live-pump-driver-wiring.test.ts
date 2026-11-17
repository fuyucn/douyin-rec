import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// Entry behavior is covered separately; keep registration on the real CLI program.
it("registers every extracted command group on the CLI program", () => {
  const path = join(__dirname, "../../packages/cli/src/cli.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const name of [
    "registerRecordCommand", "registerLivePumpCommand", "registerUposUploadCommand",
    "registerDiagnosticCommands", "registerMergeCommand", "registerBurnCommand",
    "registerUploadCommand", "registerServiceCommands", "registerRecheckCommand",
    "registerNodeCommands", "registerNodePipelineCommands", "registerRecoverOrderCommands",
  ]) {
    const entries = calls.filter((call) => call.expression.getText(source) === name);
    expect(entries, name).toHaveLength(1);
    expect(entries[0].arguments[0].getText(source)).toBe("program");
  }
});
