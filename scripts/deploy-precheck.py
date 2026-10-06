import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("  WARN 解析失败")
    sys.exit(2)
rec = [t for t in d if t.get("recording")]
run = sum(1 for t in d if t.get("running"))
if rec:
    print(f"  BLOCK 有 {len(rec)} 个任务正在录制(共 {len(d)} 任务, running={run}):")
    for t in rec:
        name = t.get("anchorName") or t.get("room")
        print(f"         #{t.get('id')} {name}")
    sys.exit(1)
print(f"  OK 无录制中任务(共 {len(d)} 任务, running={run} 在等开播)")
sys.exit(0)
