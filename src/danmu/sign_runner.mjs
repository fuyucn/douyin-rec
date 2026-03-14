// Node.js runner: 调用 webmssdk.js 的 get_sign()，将结果输出到 stdout
// 用法: node sign_runner.mjs <x_ms_stub>
import { get_sign } from "./webmssdk.js";

const stub = process.argv[2];
if (!stub) {
  process.stderr.write("usage: node sign_runner.mjs <x_ms_stub>\n");
  process.exit(1);
}

try {
  const result = get_sign(stub);
  process.stdout.write(String(result) + "\n");
} catch (e) {
  process.stderr.write("get_sign error: " + e.message + "\n");
  process.exit(1);
}
