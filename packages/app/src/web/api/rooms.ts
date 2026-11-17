/** Compatibility facade that composes all room endpoints. */
import type { ApiCtx } from "./context.js";
import { createRoomReadHandlers, createRoomReadModel } from "./rooms-read.js";
import { createRoomCreateHandlers } from "./rooms-create.js";
import { createRoomUpdateHandlers } from "./rooms-update.js";
import { createRoomDeleteHandlers } from "./rooms-delete.js";

export { rollbackKeys } from "./rooms-update.js";

export function buildRooms(ctx: ApiCtx) {
  const model = createRoomReadModel(ctx);
  return {
    ...createRoomReadHandlers(ctx, model),
    ...createRoomCreateHandlers(ctx, model),
    ...createRoomUpdateHandlers(ctx, model),
    ...createRoomDeleteHandlers(ctx, model),
  };
}
