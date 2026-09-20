// AUTHORITATIVE shared contract (see PLAN.md sections 4-5). Imported as "@shared/types".
// Changes require a PLAN.md update. All timestamps are ISO-8601 UTC strings; ids are UUID v4 strings.
export type ISODateTime = string;
export type Priority = 0 | 1 | 2 | 3; // 0 none, 1 low, 2 medium, 3 high
export type ReminderStatus = 'open' | 'done';

export interface User { id: string; email: string; name: string; pictureUrl?: string; demo: boolean; }

export interface List { id: string; name: string; color: string; sortOrder: number; createdAt: ISODateTime; updatedAt: ISODateTime; deletedAt: ISODateTime | null; }
export interface Tag { id: string; name: string; color: string; }

export interface Reminder {
  id: string;
  listId: string;
  title: string;
  notes: string;
  status: ReminderStatus;
  priority: Priority;
  dueAt: ISODateTime | null;        // null = no date
  allDay: boolean;
  timezone: string;                 // IANA, e.g. "America/New_York"
  rrule: string | null;             // RFC5545 RRULE line without "RRULE:" prefix
  snoozedUntil: ISODateTime | null;
  completedAt: ISODateTime | null;
  tagIds: string[];
  calendarSync: boolean;            // mirror to Google Calendar
  googleEventId: string | null;
  googleEtag: string | null;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt: ISODateTime | null;    // soft delete (tombstone) for sync
  version: number;                  // increments each local write; used for optimistic concurrency
}

export type SyncStatus = 'disconnected' | 'idle' | 'syncing' | 'offline' | 'error' | 'reauth_required';
export interface SyncState {
  status: SyncStatus;
  connected: boolean;
  googleEmail: string | null;
  calendarId: string;               // default "primary"
  lastSyncAt: ISODateTime | null;
  lastError: string | null;
  pendingOps: number;               // outbox size
  conflictsResolved: number;
}

export interface ApiError { error: { code: 'bad_request' | 'unauthorized' | 'not_found' | 'conflict' | 'rate_limited' | 'internal'; message: string; details?: unknown } }

export interface QuickAddParse { title: string; dueAt: ISODateTime | null; allDay: boolean; rrule: string | null; priority: Priority; tags: string[]; listName: string | null; }

export type ReminderCreate = Partial<Omit<Reminder, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'version' | 'completedAt' | 'googleEventId' | 'googleEtag'>> & { title: string };
export type ReminderPatch = Partial<ReminderCreate> & { version?: number };

export interface ListReminders { items: Reminder[]; nextCursor: string | null; }
export type ReminderFilter = 'today' | 'upcoming' | 'overdue' | 'all' | 'done';
