/**
 * The report itself: what the review screen shows and what goes into the .docx. Validated with zod
 * on the way back from the browser, because the screen lets the analyst edit every field.
 */
import { z } from "zod";

// 200: a large city easily has 60+ mobile forms or certificate types.
const list = z.array(z.string().trim().min(1).max(300)).max(200);
const level = z.object({ l1: z.number().int().min(0), l2: z.number().int().min(0), l3: z.number().int().min(0) });
const gb = z.number().min(0).max(1_000_000);

export const DiskSchema = z.object({
  name: z.string().trim().min(1).max(80),
  mount: z.string().trim().max(120),
  totalGb: gb,
  usedGb: gb,
  freeGb: gb,
});

/** List sections. Each can be left out of the document (title included) from the review screen. */
export const SECTIONS = [
  "disks",
  "layerExamples",
  "departments",
  "trainings",
  "integrations",
  "mobile",
  "certificates",
  "tickets",
  "nextSteps",
] as const;
export type Section = (typeof SECTIONS)[number];

export const MAX_DEPARTMENTS = 10;

export const TicketsSchema = z.object({ resolved: level, pending: level, canceled: z.number().int().min(0) });

export const ReportSchema = z.object({
  city: z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(120), region: z.string().max(40) }),
  period: z.object({ start: z.string(), end: z.string() }),
  contract: z.string().trim().max(40),
  users: z.number().int().min(0),
  avgAccessesPerMonth: z.number().int().min(0),
  /** Disks of the city's VM: the system disk (/) and the data disks. */
  disks: z.array(DiskSchema).max(12),
  layers: z.number().int().min(0),
  layerExamples: list,
  departments: z.array(z.string().trim().min(1).max(300)).max(MAX_DEPARTMENTS),
  trainings: list,
  integrations: list,
  mobile: list,
  certificates: list,
  /** null = the ticket source was unavailable and nobody typed the numbers in. */
  tickets: TicketsSchema.nullable(),
  /** Free text typed on the review screen; never collected. */
  nextSteps: list.default([]),
  /** Sections left out of the document entirely (heading included). */
  hidden: z.array(z.enum(SECTIONS)).max(SECTIONS.length).default([]),
  /**
   * Remark printed in italics under a section heading — set automatically when a source behind the
   * section failed ("Not available: …"), and removable on the review screen once the analyst fills
   * the section in by hand.
   */
  notes: z.record(z.enum(SECTIONS), z.string().trim().max(300)).default({}),
});

export type Report = z.infer<typeof ReportSchema>;
export type ReportInput = z.input<typeof ReportSchema>;
export type Disk = z.infer<typeof DiskSchema>;
export type Tickets = z.infer<typeof TicketsSchema>;

const sum = (n: { l1: number; l2: number; l3: number }) => n.l1 + n.l2 + n.l3;
/** Handled = resolved + pending; canceled stays apart; total = handled + canceled. */
export const handled = (t: Tickets) => sum(t.resolved) + sum(t.pending);
export const totalTickets = (t: Tickets) => handled(t) + t.canceled;
