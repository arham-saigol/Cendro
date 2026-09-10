import { sameTaskListOrder } from "./task-list-order";
import type { TaskListSort } from "./task-list-sort";

export type TaskListPreference = {
  sort: TaskListSort;
  customOrder: string[] | null;
  orderFormat?: "vector";
  revision: number;
};
type Command = { sort: TaskListSort; orderedIds?: string[] };
type Write = (command: Command & { expectedRevision: number }) => Promise<TaskListPreference>;
type Flight = { command: Command; target: TaskListPreference; expectedRevision: number };
type Snapshot = {
  preference: TaskListPreference | undefined;
  pending: boolean;
  sorting: boolean;
  dragVersion: number;
  error: string | null;
};

function samePreference(left: TaskListPreference, right: TaskListPreference) {
  return JSON.stringify(left.sort) === JSON.stringify(right.sort) &&
    sameTaskListOrder(left.customOrder ?? [], right.customOrder ?? []);
}

/** One in-flight save and one latest desired order. Conflicts discard dependent work. */
export class TaskListPreferenceController {
  private server: TaskListPreference | undefined;
  private flight: Flight | null = null;
  private queued: Command | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = { preference: undefined, pending: false, sorting: false, dragVersion: 0, error: null };

  constructor(private write: Write) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  receive(preference: TaskListPreference) {
    if (this.server && preference.revision <= this.server.revision) return;
    const flight = this.flight;
    this.server = preference;
    if (flight) {
      if (preference.revision === flight.expectedRevision + 1 && samePreference(preference, flight.target)) return;
      this.fail("Task order changed in another session. Please repeat the move.");
    } else {
      this.publish({ preference, dragVersion: this.snapshot.dragVersion + 1 });
    }
  }

  saveOrder(orderedIds: string[]) {
    if (!this.server || this.snapshot.sorting) return;
    this.enqueue({ sort: { mode: "custom" }, orderedIds: [...orderedIds] });
  }

  saveSort(sort: TaskListSort) {
    if (!this.server || this.flight || JSON.stringify(sort) === JSON.stringify(this.snapshot.preference?.sort)) return;
    this.enqueue({ sort });
  }

  private target(command: Command): TaskListPreference {
    return {
      ...this.server!,
      sort: command.sort,
      ...(command.orderedIds ? { customOrder: command.orderedIds, orderFormat: "vector" as const } : {}),
      revision: this.server!.revision + 1,
    };
  }

  private enqueue(command: Command) {
    this.queued = command;
    this.publish({
      preference: this.target(command), pending: true, sorting: !command.orderedIds, error: null,
    });
    if (!this.flight) void this.flush();
  }

  private async flush() {
    if (!this.queued || !this.server) return;
    const command = this.queued;
    this.queued = null;
    const flight = { command, target: this.target(command), expectedRevision: this.server.revision };
    this.flight = flight;
    try {
      const saved = await this.write({ ...command, expectedRevision: flight.expectedRevision });
      if (this.flight !== flight) return;
      if (this.server.revision > saved.revision) {
        this.fail("Task order changed in another session. Please repeat the move.");
        return;
      }
      this.server = saved;
      this.flight = null;
      if (this.queued && !samePreference(saved, this.target(this.queued))) {
        void this.flush();
      } else {
        this.queued = null;
        this.publish({ preference: saved, pending: false, sorting: false });
      }
    } catch (error) {
      if (this.flight !== flight) return;
      // An acknowledgement can be lost after the subscription already confirmed it.
      if (this.server.revision === flight.expectedRevision + 1 && samePreference(this.server, flight.target)) {
        this.flight = null;
        if (this.queued) void this.flush();
        else this.publish({ preference: this.server, pending: false, sorting: false });
      } else {
        this.fail(error instanceof Error ? error.message : "Could not save task order.");
      }
    }
  }

  private fail(error: string) {
    this.flight = null;
    this.queued = null;
    this.publish({
      preference: this.server, pending: false, sorting: false,
      dragVersion: this.snapshot.dragVersion + 1, error,
    });
  }

  cancel() {
    this.flight = null;
    this.queued = null;
  }
}
