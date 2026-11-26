/**
 * Training and certification.
 *
 * The audit said the old training register was a list of manually entered events,
 * not a certification system. These tests prove the parts that make it one:
 * completion is computed, certificates come from completion, they expire, they
 * revoke, and a third party can verify one without seeing contact details.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";

const { ctxHolder } = vi.hoisted(() => ({
  ctxHolder: { current: null as null | Record<string, unknown> },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/tenant", () => ({
  requireTenantAdmin: async () => ctxHolder.current,
  requireTenantAdminSusu: async () => ctxHolder.current,
  requireTenantCustomer: async () => ctxHolder.current,
  getTenantContext: async () => ctxHolder.current,
  getApiTenantContext: async () => ctxHolder.current,
}));

import {
  addTrainingModule,
  createTrainingAssessment,
  createTrainingCourse,
  enrolLearner,
  getLearnerTranscript,
  getTrainingOverview,
  issueTrainingCertificate,
  markTrainingSessionHeld,
  publishTrainingCourse,
  recordTrainingAttempt,
  recordTrainingAttendance,
  revokeTrainingCertificate,
  scheduleTrainingSession,
  verifyTrainingCertificate,
} from "@/lib/actions/training.actions";
import {
  certificateExpiry,
  certificateRetention,
  certificateSerial,
  certificateState,
  evaluateCompletion,
  maskLearnerName,
} from "@/lib/training";

let tenantId: string;
let adminId: string;
let associationId: string;
let memberId: string;
let courseId: string;
let enrolmentId: string;
let sessionId: string;
let assessmentId: string;

async function asAdmin() {
  ctxHolder.current = {
    tenantId,
    tenantName: "Training Tenant",
    tenantCode: "TT",
    userId: adminId,
    role: "admin",
    modules: ["admin"],
  };
}

beforeEach(async () => {
  await cleanDatabase();
  const tenant = await prisma.businessTenant.create({
    data: {
      code: `TRN-${Math.random().toString(36).slice(2, 8)}`,
      name: "Training Tenant",
      status: "ACTIVE",
      susuEnabled: true,
    },
  });
  tenantId = tenant.id;
  const admin = await prisma.user.create({
    data: {
      tenantId,
      email: `trn-admin-${Math.random().toString(36).slice(2, 8)}@test.local`,
      fullName: "Training Admin",
      role: "admin",
      status: "active",
      passwordHash: "x",
    },
  });
  adminId = admin.id;
  const association = await prisma.association.create({
    data: {
      tenantId,
      code: "MOMAG",
      name: "MoMAG",
      createdById: adminId,
    },
  });
  associationId = association.id;
  const member = await prisma.associationMember.create({
    data: {
      tenantId,
      associationId,
      memberCode: "M-1",
      businessName: "Member Business",
      contactName: "Ama Learner",
      status: "active",
      createdById: adminId,
    },
  });
  memberId = member.id;
  await asAdmin();

  const course = await createTrainingCourse({
    associationId,
    code: "AML",
    title: "Anti-money laundering basics",
    passingScore: 70,
    requiredAttendancePct: 80,
    validityMonths: 12,
    retentionYears: 5,
  });
  expect(course.success, course.error).toBe(true);
  courseId = course.data!.courses[0].id;

  const moduleAdded = await addTrainingModule({
    courseId,
    position: 1,
    title: "Why cash controls matter",
    content: "An introduction.",
  });
  expect(moduleAdded.success, moduleAdded.error).toBe(true);

  const published = await publishTrainingCourse({ courseId, publish: true });
  expect(published.success, published.error).toBe(true);

  const enrolled = await enrolLearner({
    courseId,
    memberId,
    learnerName: "Ama Learner",
  });
  expect(enrolled.success, enrolled.error).toBe(true);
  enrolmentId = enrolled.data!.enrolments[0].id;

  const session = await scheduleTrainingSession({
    courseId,
    title: "Session one",
    scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
    durationMinutes: 90,
  });
  expect(session.success, session.error).toBe(true);

  const assessment = await createTrainingAssessment({
    courseId,
    title: "Final assessment",
    maxScore: 100,
    passingScore: 70,
  });
  expect(assessment.success, assessment.error).toBe(true);

  const rows = await prisma.trainingSession.findMany({ where: { courseId } });
  sessionId = rows[0].id;
  const tests = await prisma.trainingAssessment.findMany({ where: { courseId } });
  assessmentId = tests[0].id;
});

describe("course lifecycle", () => {
  it("refuses to publish a course with no modules", async () => {
    const created = await createTrainingCourse({
      associationId,
      code: "EMPTY",
      title: "Course with no modules",
      passingScore: 60,
      requiredAttendancePct: 50,
      validityMonths: 6,
      retentionYears: 3,
    });
    const emptyCourse = created.data!.courses.find((course) => course.code === "EMPTY")!;
    const published = await publishTrainingCourse({ courseId: emptyCourse.id, publish: true });
    expect(published.success).toBe(false);
    expect(published.error).toMatch(/at least one module/i);
  });

  it("refuses a duplicate course code and version", async () => {
    const again = await createTrainingCourse({
      associationId,
      code: "AML",
      title: "Duplicate",
      passingScore: 70,
      requiredAttendancePct: 80,
      validityMonths: 12,
      retentionYears: 5,
    });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already exist/i);
  });

  it("refuses enrolment before the course is published", async () => {
    const created = await createTrainingCourse({
      associationId,
      code: "DRAFT",
      title: "Draft course",
      passingScore: 60,
      requiredAttendancePct: 50,
      validityMonths: 6,
      retentionYears: 3,
    });
    const draft = created.data!.courses.find((course) => course.code === "DRAFT")!;
    const result = await enrolLearner({
      courseId: draft.id,
      memberId,
      learnerName: "Ama Learner",
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/publish the course/i);
  });
});

describe("attendance and assessment", () => {
  it("records attendance only up to the session length", async () => {
    const tooLong = await recordTrainingAttendance({
      sessionId,
      enrolmentId,
      minutes: 200,
    });
    expect(tooLong.success).toBe(false);
    expect(tooLong.error).toMatch(/cannot exceed/i);

    const held = await markTrainingSessionHeld({ sessionId });
    expect(held.success, held.error).toBe(true);
    const recorded = await recordTrainingAttendance({
      sessionId,
      enrolmentId,
      minutes: 90,
    });
    expect(recorded.success, recorded.error).toBe(true);
    const view = recorded.data!.enrolments.find((row) => row.id === enrolmentId)!;
    expect(view.attendancePct).toBe(100);
    expect(view.status).toBe("in_progress");
  });

  it("refuses attendance for a learner on another course", async () => {
    const other = await createTrainingCourse({
      associationId,
      code: "OTHER",
      title: "Other course",
      passingScore: 60,
      requiredAttendancePct: 50,
      validityMonths: 6,
      retentionYears: 3,
    });
    const otherCourse = other.data!.courses.find((course) => course.code === "OTHER")!;
    await addTrainingModule({
      courseId: otherCourse.id,
      position: 1,
      title: "Module",
    });
    await publishTrainingCourse({ courseId: otherCourse.id, publish: true });
    const otherSession = await scheduleTrainingSession({
      courseId: otherCourse.id,
      title: "Their session",
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationMinutes: 60,
    });
    const theirSession = otherSession.data!.courses.find(
      (course) => course.id === otherCourse.id
    )!;
    expect(theirSession).toBeTruthy();
    const rows = await prisma.trainingSession.findMany({ where: { courseId: otherCourse.id } });
    const result = await recordTrainingAttendance({
      sessionId: rows[0].id,
      enrolmentId,
      minutes: 30,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not enrolled on this course/i);
  });

  it("completes the learner only when attendance and the pass mark are both met", async () => {
    await markTrainingSessionHeld({ sessionId });

    // A passed score without attendance is not completion.
    const firstAttempt = await recordTrainingAttempt({
      assessmentId,
      enrolmentId,
      score: 80,
    });
    expect(firstAttempt.success, firstAttempt.error).toBe(true);
    const blocked = firstAttempt.data!.enrolments.find((row) => row.id === enrolmentId)!;
    expect(blocked.status).toBe("in_progress");
    expect(blocked.blockers.join(" ")).toMatch(/attendance/i);

    await recordTrainingAttendance({ sessionId, enrolmentId, minutes: 90 });
    const passed = await recordTrainingAttempt({
      assessmentId,
      enrolmentId,
      score: 85,
    });
    const completed = passed.data!.enrolments.find((row) => row.id === enrolmentId)!;
    expect(completed.status).toBe("completed");
    expect(completed.blockers).toEqual([]);
    expect(completed.attendancePct).toBe(100);
  });

  it("keeps the learner incomplete when the best score is below the pass mark", async () => {
    await markTrainingSessionHeld({ sessionId });
    await recordTrainingAttendance({ sessionId, enrolmentId, minutes: 90 });
    const failed = await recordTrainingAttempt({ assessmentId, enrolmentId, score: 40 });
    const row = failed.data!.enrolments.find((entry) => entry.id === enrolmentId)!;
    expect(row.status).not.toBe("completed");
    expect(row.blockers.join(" ")).toMatch(/pass mark/i);
  });

  it("refuses a score above the assessment maximum", async () => {
    const result = await recordTrainingAttempt({ assessmentId, enrolmentId, score: 120 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/maximum score/i);
  });
});

describe("certification", () => {
  async function completeLearner() {
    await markTrainingSessionHeld({ sessionId });
    await recordTrainingAttendance({ sessionId, enrolmentId, minutes: 90 });
    const attempt = await recordTrainingAttempt({ assessmentId, enrolmentId, score: 90 });
    expect(attempt.success, attempt.error).toBe(true);
  }

  it("refuses a certificate before completion", async () => {
    const result = await issueTrainingCertificate({ enrolmentId });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only after the learner has completed/i);
    expect(await prisma.trainingCertificate.count()).toBe(0);
  });

  it("issues one certificate with an expiry and a verification token", async () => {
    await completeLearner();
    const issued = await issueTrainingCertificate({ enrolmentId });
    expect(issued.success, issued.error).toBe(true);

    const certificate = await prisma.trainingCertificate.findFirstOrThrow({
      where: { enrolmentId },
    });
    expect(certificate.serial).toMatch(/^AML-\d{4}-\d{4}$/);
    expect(certificate.verificationToken).toMatch(/^[0-9a-f]{48}$/);
    expect(certificate.expiresAt.getTime()).toBeGreaterThan(certificate.issuedAt.getTime());
    expect(certificate.retainUntil.getTime()).toBeGreaterThan(certificate.expiresAt.getTime());

    const again = await issueTrainingCertificate({ enrolmentId });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already has a certificate/i);
  });

  it("verifies a live certificate without exposing contact details", async () => {
    await completeLearner();
    await issueTrainingCertificate({ enrolmentId });
    const certificate = await prisma.trainingCertificate.findFirstOrThrow({
      where: { enrolmentId },
    });
    const result = await verifyTrainingCertificate(certificate.verificationToken);
    expect(result.found).toBe(true);
    expect(result.state).toBe("issued");
    expect(result.courseTitle).toBe("Anti-money laundering basics");
    // The holder is masked, and no phone or email is returned at all.
    expect(result.holder).toBe("A. Learner");
    expect(JSON.stringify(result)).not.toMatch(/\+233|@test\.local/);
  });

  it("reports an expired certificate rather than a valid one", async () => {
    await completeLearner();
    await issueTrainingCertificate({ enrolmentId });
    const certificate = await prisma.trainingCertificate.findFirstOrThrow({
      where: { enrolmentId },
    });
    await prisma.trainingCertificate.update({
      where: { id: certificate.id },
      data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
    });
    const result = await verifyTrainingCertificate(certificate.verificationToken);
    expect(result.state).toBe("expired");
  });

  it("revokes a certificate with a reason and verification says so", async () => {
    await completeLearner();
    await issueTrainingCertificate({ enrolmentId });
    const certificate = await prisma.trainingCertificate.findFirstOrThrow({
      where: { enrolmentId },
    });

    const short = await revokeTrainingCertificate({
      certificateId: certificate.id,
      reason: "no",
    });
    expect(short.success).toBe(false);

    const revoked = await revokeTrainingCertificate({
      certificateId: certificate.id,
      reason: "The assessment was later found to have been marked incorrectly.",
    });
    expect(revoked.success, revoked.error).toBe(true);
    const result = await verifyTrainingCertificate(certificate.verificationToken);
    expect(result.state).toBe("revoked");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "training.certificate_revoked" },
    });
    expect(JSON.parse(String(audit?.details)).financialMutation).toBe(false);
  });

  it("answers honestly for an unknown or malformed token", async () => {
    expect((await verifyTrainingCertificate("not-a-token")).found).toBe(false);
    expect((await verifyTrainingCertificate("f".repeat(48))).found).toBe(false);
  });

  it("keeps the certificate serial readable and year-scoped", () => {
    const issued = new Date("2026-03-04T09:00:00Z");
    // The course part is capped at eight characters so a serial stays readable.
    expect(certificateSerial("aml/basics", issued, 7)).toBe("AMLBASIC-2026-0007");
    expect(certificateSerial("", issued, 1)).toBe("COURSE-2026-0001");
    expect(certificateExpiry(issued, 12).toISOString()).toBe("2027-03-04T09:00:00.000Z");
    expect(certificateRetention(new Date("2027-03-04T09:00:00Z"), 5).toISOString()).toBe(
      "2032-03-04T09:00:00.000Z"
    );
    expect(maskLearnerName("Ama Mensah")).toBe("A. Mensah");
    expect(maskLearnerName("Ama")).toBe("A.");
    expect(maskLearnerName("")).toBe("Learner");
  });

  it("treats a revoked certificate as revoked even before its expiry", () => {
    const issuedAt = new Date("2026-01-01T00:00:00Z");
    expect(
      certificateState(
        { status: "issued", issuedAt, expiresAt: new Date("2027-01-01T00:00:00Z"), revokedAt: null },
        new Date("2026-06-01T00:00:00Z")
      )
    ).toBe("issued");
    expect(
      certificateState(
        {
          status: "revoked",
          issuedAt,
          expiresAt: new Date("2027-01-01T00:00:00Z"),
          revokedAt: new Date("2026-05-01T00:00:00Z"),
        },
        new Date("2026-06-01T00:00:00Z")
      )
    ).toBe("revoked");
  });
});

describe("completion rules", () => {
  it("does not fail a learner on attendance when no session was held", () => {
    const result = evaluateCompletion({
      requiredAttendancePct: 100,
      passingScore: 70,
      sessionsHeld: 0,
      sessionsAttended: 0,
      bestScore: 75,
    });
    expect(result.complete).toBe(true);
    expect(result.attendancePct).toBe(100);
  });

  it("requires an attempt at all", () => {
    const result = evaluateCompletion({
      requiredAttendancePct: 80,
      passingScore: 70,
      sessionsHeld: 1,
      sessionsAttended: 1,
      bestScore: null,
    });
    expect(result.complete).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/no assessment attempt/i);
  });

  it("rounds attendance down so a partial session cannot pass", () => {
    const result = evaluateCompletion({
      requiredAttendancePct: 80,
      passingScore: 70,
      sessionsHeld: 3,
      sessionsAttended: 2,
      bestScore: 90,
    });
    expect(result.attendancePct).toBe(67);
    expect(result.complete).toBe(false);
  });
});

describe("transcripts and isolation", () => {
  it("returns a transcript for one learner and nobody else", async () => {
    await markTrainingSessionHeld({ sessionId });
    await recordTrainingAttendance({ sessionId, enrolmentId, minutes: 90 });
    await recordTrainingAttempt({ assessmentId, enrolmentId, score: 95 });

    const mine = await getLearnerTranscript({ memberId });
    expect(mine.success, mine.error).toBe(true);
    expect(mine.learnerName).toBe("Ama Learner");
    expect(mine.rows?.[0].courseTitle).toBe("Anti-money laundering basics");

    const other = await prisma.associationMember.create({
      data: {
        tenantId,
        associationId,
        memberCode: "M-2",
        businessName: "Second Member",
        contactName: "Kofi Learner",
        status: "active",
        createdById: adminId,
      },
    });
    const nobody = await getLearnerTranscript({ memberId: other.id });
    expect(nobody.success).toBe(false);
    expect(nobody.error).toMatch(/no training records/i);
  });

  it("does not show another business's courses", async () => {
    const otherTenant = await prisma.businessTenant.create({
      data: { code: "TRN-OTHER", name: "Other", status: "ACTIVE", susuEnabled: true },
    });
    const otherAdmin = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        email: `trn-other-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Other Admin",
        role: "admin",
        status: "active",
        passwordHash: "x",
      },
    });
    const otherAssociation = await prisma.association.create({
      data: { tenantId: otherTenant.id, code: "OTHER", name: "Other", createdById: otherAdmin.id },
    });
    await prisma.trainingCourse.create({
      data: {
        tenantId: otherTenant.id,
        associationId: otherAssociation.id,
        code: "HIDDEN",
        title: "Hidden course",
        createdById: otherAdmin.id,
      },
    });

    const view = await getTrainingOverview();
    expect(view.data!.courses.map((course) => course.code)).not.toContain("HIDDEN");
    expect(view.data!.courses.map((course) => course.code)).toContain("AML");
  });
});
