import { sameListOrder } from "./list-order";

export type ListSortLike = { mode: string };

export type ListPreference<TSort extends ListSortLike> = {
  sort: TSort;
  customOrder: string[] | null;
  orderFormat?: "vector";
  revision: number;
};

export type ListPreferenceControllerOptions = {
  /** Shown when another session changed the preference while a local move was in flight. */
  conflict: string;
  /** Fallback shown when a save fails without its own message. */
  saveFailed: string;
};

type Command<TSort extends ListSortLike> = { sort: TSort; orderedIds?: string[] };
type Write<TSort extends ListSortLike> = (
  command: Command<TSort> & { expectedRevision: number },
) => Promise<ListPreference<TSort>>;
type Flight<TSort extends ListSortLike> = {
  command: Command<TSort>;
  target: ListPreference<TSort>;
  expectedRevision: number;
};
type Snapshot<TSort extends ListSortLike> = {
  preference: ListPreference<TSort> | undefined;
  pending: boolean;
  sorting: boolean;
  dragVersion: number;
  error: string | null;
};

function samePreference<TSort extends ListSortLike>(
  left: ListPreference<TSort>,
  right: ListPreference<TSort>,
) {
  return JSON.stringify(left.sort) === JSON.stringify(right.sort) &&
    left.orderFormat === right.orderFormat &&
    (left.customOrder === null || right.customOrder === null
      ? left.customOrder === right.customOrder
      : sameListOrder(left.customOrder, right.customOrder));
}

// The controller owns every custom-order save, so it is the one place that knows a manual move
// always means custom mode, whatever union of sorts the caller subscribes to.
function customSort<TSort extends ListSortLike>() {
  return { mode: "custom" } as TSort;
}

/** One in-flight save and one latest desired order. Conflicts discard dependent work. */
export class ListPreferenceController<TSort extends ListSortLike> {
  private server: ListPreference<TSort> | undefined;
  private flight: Flight<TSort> | null = null;
  private queued: Command<TSort> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot<TSort> = {
    preference: undefined, pending: false, sorting: false, dragVersion: 0, error: null,
  };

  constructor(
    private write: Write<TSort>,
    private messages: ListPreferenceControllerOptions,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<Snapshot<TSort>>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  receive(preference: ListPreference<TSort>) {
    if (this.server && preference.revision <= this.server.revision) return;
    const flight = this.flight;
    this.server = preference;
    if (flight) {
      if (preference.revision === flight.expectedRevision + 1 && samePreference(preference, flight.target)) return;
      this.fail(this.messages.conflict);
    } else {
      this.publish({ preference, dragVersion: this.snapshot.dragVersion + 1 });
    }
  }

  saveOrder(orderedIds: string[]) {
    if (!this.server || this.snapshot.sorting) return;
    this.enqueue({ sort: customSort<TSort>(), orderedIds: [...orderedIds] });
  }

  saveSort(sort: TSort) {
    if (!this.server || this.flight || JSON.stringify(sort) === JSON.stringify(this.snapshot.preference?.sort)) return;
    this.enqueue({ sort });
  }

  private target(command: Command<TSort>): ListPreference<TSort> {
    return {
      ...this.server!,
      sort: command.sort,
      ...(command.orderedIds ? { customOrder: command.orderedIds, orderFormat: "vector" as const } : {}),
      revision: this.server!.revision + 1,
    };
  }

  private enqueue(command: Command<TSort>) {
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
        this.fail(this.messages.conflict);
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
        this.fail(error instanceof Error ? error.message : this.messages.saveFailed);
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
