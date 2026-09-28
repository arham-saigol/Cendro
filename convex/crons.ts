import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("record missed JD cycles", { hours: 1 }, internal.tasks.recordMissedJdCyclesBatch, {});
crons.interval("sweep expired task upload claims", { hours: 24 }, internal.tasks.sweepExpiredTaskUploadClaims, {});
crons.interval("purge expired AI persistence receipts", { hours: 24 }, internal.aiChat.purgeExpiredPersistenceReceipts, {});

export default crons;
