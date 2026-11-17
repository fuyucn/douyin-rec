import { addArchiveToSeasonIfConfigured, seasonCheckpointState } from "@drec/bilibili-api";
import type { LivePumpReporter } from "@drec/core";
import type { LivePumpState } from "./live-pump-state.js";

type SeasonState = NonNullable<LivePumpState["seasonState"]>;

interface SeasonOptions {
  cookiesPath: string;
  seasonSectionId?: number;
  fetchImpl?: typeof fetch;
  reporter?: LivePumpReporter;
}

interface SeasonCheckpoint {
  read(): Pick<LivePumpState, "aid" | "bvid" | "seasonState">;
  apply(state: SeasonState): void;
  persist(): void;
}

/** Best-effort metadata work; the session remains the only durable state writer. */
export class LivePumpSeason {
  private tail: Promise<void> = Promise.resolve();
  private writeFails = false;

  constructor(
    private readonly o: SeasonOptions,
    private readonly checkpoint: SeasonCheckpoint,
    private readonly log: (message: string) => void,
  ) {}

  private async associate(doFetch: typeof fetch, reconcileFirst: boolean): Promise<void> {
    if (!this.o.seasonSectionId) return;
    const state = this.checkpoint.read();
    if (state.seasonState === "done" || state.seasonState === "failed") return;
    const outcome = await addArchiveToSeasonIfConfigured({
      cookiesPath: this.o.cookiesPath,
      sectionId: this.o.seasonSectionId,
      ...(state.aid ? { aid: state.aid } : {}),
      ...(state.bvid ? { bvid: state.bvid } : {}),
      reconcileFirst,
      fetchImpl: doFetch,
      note: (message) => this.log(message),
    });
    const next = seasonCheckpointState(outcome);
    // Apply only metadata to the latest session state, never an earlier whole-state snapshot.
    this.checkpoint.apply(next);
    try {
      this.o.reporter?.event({ at: Date.now(), kind: `season_${next}` });
    } catch { /* observability */ }
    try {
      if (this.writeFails) {
        this.writeFails = false;
        throw new Error("injected season checkpoint write failure");
      }
      this.checkpoint.persist();
    } catch (e) {
      this.log(`[直播直传] season 状态落盘失败(保留 pending,不影响后续分 P): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  queue(doFetch: typeof fetch, reconcileFirst: boolean): void {
    const state = this.checkpoint.read();
    if (state.seasonState === "done" || state.seasonState === "failed") return;
    this.tail = this.tail
      .then(() => this.associate(doFetch, reconcileFirst))
      .catch((e) => {
        this.log(`[直播直传] season association exception (left pending): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      });
  }

  /** Wait at run boundaries, not on the part-upload path. */
  drain(): Promise<void> { return this.tail; }

  /** Existing test seam for a metadata-only checkpoint failure. */
  failWriteOnce(): void { this.writeFails = true; }

  /** Only an explicit pending checkpoint needs restart reconciliation. */
  async reconcile(fetchImpl?: typeof fetch): Promise<void> {
    if (!this.o.seasonSectionId || this.checkpoint.read().seasonState !== "pending") return;
    await this.associate(fetchImpl ?? this.o.fetchImpl ?? fetch, true);
  }
}
