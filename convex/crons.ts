import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("record missed JD cycles", { hours: 1 }, internal.tasks.recordMissedJdCyclesBatch, {});
crons.interval("sweep expired task upload claims", { hours: 24 }, internal.tasks.sweepExpiredTaskUploadClaims, {});

export default crons;
