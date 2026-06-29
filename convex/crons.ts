import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("record missed JD cycles", { hours: 1 }, internal.tasks.recordMissedJdCyclesBatch, {});

export default crons;
