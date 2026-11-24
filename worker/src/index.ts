// Hono app: route registration and a global error handler only. No logic
// of its own (plan.md §Source Code). Routes are added here as each one is
// implemented; this file's job never grows beyond wiring.
import { Hono } from "hono";
import type { Env, Variables } from "./types";
import { AppError, toResponse } from "./lib/errors";
import { redact } from "./lib/redact";
import { installRoute } from "./routes/install";
import { dailyRoute } from "./routes/daily";
import { problemsRoute } from "./routes/problems";
import { sessionResetRoute } from "./routes/session-reset";
import { sttRoute } from "./routes/stt";
import { practiceRoute } from "./routes/practice";
import { v2TurnRoute } from "./routes/v2-turn";
import { v2JudgeRoute } from "./routes/v2-judge";
import { v2RepairRoute } from "./routes/v2-repair";
import { configRoute } from "./routes/config";
import { privacyRoute } from "./routes/privacy";
import { notifyRoute } from "./routes/notify";
import { installAuth } from "./middleware/install-auth";
import { webCors } from "./middleware/web-cors";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.route("/v1/install", installRoute);
// The model routes of the step protocol (feature 010): the relay holds no model
// key and calls no model, so /v1/chat, /v1/judge, /v1/trial and /v1/repair are gone.
app.use("/v2/turn", installAuth);
app.route("/v2/turn", v2TurnRoute);
app.use("/v2/judge", installAuth);
app.route("/v2/judge", v2JudgeRoute);
app.use("/v2/repair", installAuth);
app.route("/v2/repair", v2RepairRoute);
app.use("/v1/daily", installAuth);
app.route("/v1/daily", dailyRoute);
app.use("/v1/problems", installAuth);
app.route("/v1/problems", problemsRoute);
app.use("/v1/session/reset", installAuth);
app.route("/v1/session/reset", sessionResetRoute);
app.use("/v1/stt", installAuth);
app.route("/v1/stt", sttRoute);
app.route("/v1/practice", practiceRoute);
app.route("/v1/config", configRoute);
// Website only: CORS-guarded, no install auth (feature 007).
app.use("/v1/notify", webCors);
app.route("/v1/notify", notifyRoute);
// Public, unauthenticated, and deliberately outside /v1: this is a page for
// people and store reviewers, not an API surface.
app.route("/privacy", privacyRoute);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return toResponse(err);
  }
  console.error("unhandled error", redact({ message: err.message, stack: err.stack }));
  return toResponse(new AppError("UNCLEAR_RETRY"));
});

export default app;
