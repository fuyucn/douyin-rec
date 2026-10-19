# 040 派生分P弹幕 xml 的回收与总 xml 区分(issue #84)

## Goal

分段模式(「合并分段」关闭)从会话总 xml 派生的每分P弹幕 xml,要能**只回收派生文件**,总 xml 与最后一份弹幕永不受影响;
并消除「派生文件与会话级 xml 按命名规则无法区分」的隐患。属删除类,先方案后实现。

## 现状(2026-10-18 核对)

- 派生:`segment-pipeline.ts` `derivePartDanmuXml` 写 `<stageSub>/{dateName}_{NNN}.xml`(`derivePartXmlPath` + `segmentStem`),
  stage 里同时可能有会话级 `{dateName}.xml`。
- **命名冲突**:core `session-name.ts` 把 `_\d{3,}` 当分段后缀,`sessionBaseOf("{dateName}_001.xml") === "{dateName}"`,
  与会话级 `{dateName}.xml` 同基名 —— 任何按基名归组的消费点都分不清派生与总 xml。已知按基名消费 stage 的:
  维护清理 `app/orphan-cleanup.ts`(扫 recordings + stage,按基名判「别处有非空副本」)。
- 回收:`stageAfterDone` 开时 `clean_stage` 按 `*.xml|*.ass` 通配删整个 stage 子目录(`segment-pipeline.ts` 两处),
  不区分派生与总 xml 副本 —— 按 `xmlKeepRule` 口径合法(节点源 xml 保留),但不是「只回收派生」;
  `stageAfterDone` 关时派生文件永久留在 stage;切回「合并分段」后没有任何路径回收它们。

## 设计

**不改名、不靠通配:派生清单(manifest)是唯一真理。**

- `derivePartDanmuXml` 每写一个派生文件,同步登记到 `<stageSub>/{dateName}.derived-xml.json`
  (`{ v:1, files:[{ name, sourceXml(basename), window, bytes, sha256 }] }`,原子写)。已存在而跳过的不重复登记。
- `isDerivedPartXml(stageSub, name)`:只有清单里登记、且当前内容哈希与登记一致的文件才算派生。
  手工改过 / 哈希不符 / 不在清单 → **按总 xml 对待(保护)**。
- 回收 `recycleDerivedPartXml(stageSub)`:只删清单内且哈希一致的文件,删后从清单移除;
  永不触及清单外任何 xml / ass;总 xml 文件名(`{dateName}.xml` 与会话级 stamped 名)即使误入清单也拒删(双保险)。
- 触发点(待拍板,见下):
  - A. 本场收口时若规则已切回「合并分段」→ 回收该场 stage 子目录的派生文件;
  - B. 维护页「清理」预览里单列「派生分P弹幕 xml」一类(默认 dryRun,确认后删,写审计日志);
  - 不做定时自动回收。
- `orphan-cleanup.ts`:派生文件不计入「别处有非空副本」的证据(否则派生可能被当成总 xml 的副本,让空壳总 xml 被判可删)。
- `clean_stage` 通配删除保持现状(按 `xmlKeepRule`,stage 清空时节点源 xml 保留),不在本计划内改。

## Global Constraints

- 总 xml(stage 副本与节点源)与最后一份弹幕永不进入派生回收集;判不出来一律保留。
- 删除只在 stage 子目录内;`recordings/` 不涉及(hook 也会拦)。
- 清单缺失 / 损坏 → 视为「没有派生文件」,不回收(旧场的派生文件只能经维护页人工确认)。

## Tasks

- [ ] T1 清单写入 + `isDerivedPartXml`(纯函数,不删任何文件)。验收:写入幂等、哈希不符视为非派生、清单损坏不抛。
- [ ] T2 `orphan-cleanup` 排除派生证据。验收:空壳总 xml + 非空派生 → 总 xml 保留。
- [ ] T3 回收函数 + 触发点(按拍板结果)。验收:派生开启 → 关闭 → 回收,断言总 xml 存在且字节不变;清单外 xml 不动;
      哈希不符不动;总 xml 名误入清单拒删。
- T3 为删除类:`needs-decision` + Opus 设计复审 + `pr-risk-scan` 后再合并。

## 待拍板

- 触发点选 A、B 或两者(建议:先 B,只在维护页人工确认回收;A 等 B 跑一段时间再开)。
- 旧场(无清单)的派生文件是否需要一次性人工清点脚本(建议不做,维护页按清单外文件不处理)。
