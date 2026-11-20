"use server";

import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLogTx } from "@/lib/audit";
import {
  attendanceSchema,
  attemptSchema,
  certificateExpiry,
  certificateRetention,
  certificateSerial,
  certificateState,
  certificateRevokeSchema,
  enrolmentSchema,
  evaluateCompletion,
  trainingCourseSchema,
  trainingModuleSchema,
  trainingSessionSchema,
} from "@/lib/training";

/**
 * Training courses, enrolment, attendance, assessment and certificates.
 *
 * Completion is computed from attendance and a passing attempt, never set by
 * hand. A certificate is issued only from a completed enrolment, carries an
 * expiry and a verification token, and can be revoked with a reason. Every write
 * is audited with `financialMutation: false`.
 */

export interface TrainingCourseView {
  id: string;
  associationId: string;
  code: string;
  title: string;
  version: string;
  status: string;
  passingScore: number;
  requiredAttendancePct: number;
  validityMonths: number;
  modules: number;
  sessions: number;
  enrolments: number;
  completed: number;
}

export interface TrainingEnrolmentView {
  id: string;
  courseId: string;
  courseTitle: string;
  learnerName: string;
  status: string;
  attendancePct: number;
  bestScore: number | null;
  passingScore: number;
  requiredAttendancePct: number;
  certificateSerial: string | null;
  certificateState: string | null;
  certificateExpiresAt: string | null;
  blockers: string[];
}

export interface TrainingOverview {
  courses: TrainingCourseView[];
  enrolments: TrainingEnrolmentView[];
  certificates: Array<{
    id: string;
    serial: string;
    learnerName: string;
    courseTitle: string;
    state: string;
    issuedAt: string;
    expiresAt: string;
    retainedUntil: string;
  }>;
  canManage: boolean;
}

export interface TrainingResponse {
  success: boolean;
  error?: string;
  data?: TrainingOverview;
}

async function associationIdsFor(tenantId: string): Promise<string[]> {
  const rows = await db.association.findMany({
    where: { tenantId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Read the training picture.
 *
 * Association administrators and zone officers manage it; auditors and member
 * viewers may read. A business administrator keeps the register access they
 * already had, which is why they are not blocked here.
 */
export async function getTrainingOverview(): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const associationIds = await associationIdsFor(ctx.tenantId);

  const [courses, enrolments, certificates, roles] = await Promise.all([
    db.trainingCourse.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { modules: true, sessions: true, enrolments: true } },
        sessions: { select: { id: true, status: true } },
        enrolments: { select: { id: true, status: true } },
      },
    }),
    db.trainingEnrolment.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { enrolledAt: "desc" },
      take: 200,
      include: {
        course: {
          select: {
            title: true,
            passingScore: true,
            requiredAttendancePct: true,
            sessions: { select: { id: true, status: true } },
          },
        },
        attendance: { select: { sessionId: true, minutes: true } },
        attempts: { select: { score: true, passed: true } },
        certificate: {
          select: {
            serial: true,
            status: true,
            issuedAt: true,
            expiresAt: true,
            revokedAt: true,
          },
        },
      },
    }),
    db.trainingCertificate.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { issuedAt: "desc" },
      take: 200,
      include: {
        enrolment: { select: { learnerName: true, course: { select: { title: true } } } },
      },
    }),
    db.associationRoleAssignment.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, revokedAt: null },
      select: { role: true },
    }),
  ]);

  const canManage =
    roles.length === 0 ||
    roles.some((row) =>
      ["association_admin", "zone_officer"].includes(row.role)
    );

  return {
    success: true,
    data: {
      courses: courses
        .filter((course) => associationIds.includes(course.associationId))
        .map((course) => ({
          id: course.id,
          associationId: course.associationId,
          code: course.code,
          title: course.title,
          version: course.version,
          status: course.status,
          passingScore: course.passingScore,
          requiredAttendancePct: course.requiredAttendancePct,
          validityMonths: course.validityMonths,
          modules: course._count.modules,
          sessions: course._count.sessions,
          enrolments: course._count.enrolments,
          completed: course.enrolments.filter((row) => row.status === "completed").length,
        })),
      enrolments: enrolments.map((row) => {
        const sessionsHeld = row.course.sessions.filter(
          (session) => session.status === "held"
        ).length;
        const heldIds = new Set(
          row.course.sessions
            .filter((session) => session.status === "held")
            .map((session) => session.id)
        );
        const attended = new Set(
          row.attendance
            .filter((attendance) => heldIds.has(attendance.sessionId) && attendance.minutes > 0)
            .map((attendance) => attendance.sessionId)
        ).size;
        const bestScore = row.attempts.length
          ? Math.max(...row.attempts.map((attempt) => attempt.score))
          : null;
        const completion = evaluateCompletion({
          requiredAttendancePct: row.course.requiredAttendancePct,
          passingScore: row.course.passingScore,
          sessionsHeld,
          sessionsAttended: attended,
          bestScore,
        });
        return {
          id: row.id,
          courseId: row.courseId,
          courseTitle: row.course.title,
          learnerName: row.learnerName,
          status: row.status,
          attendancePct: completion.attendancePct,
          bestScore,
          passingScore: row.course.passingScore,
          requiredAttendancePct: row.course.requiredAttendancePct,
          certificateSerial: row.certificate?.serial ?? null,
          certificateState: row.certificate ? certificateState(row.certificate) : null,
          certificateExpiresAt: row.certificate?.expiresAt.toISOString() ?? null,
          blockers: completion.reasons,
        };
      }),
      certificates: certificates.map((row) => ({
        id: row.id,
        serial: row.serial,
        learnerName: row.enrolment.learnerName,
        courseTitle: row.enrolment.course.title,
        state: certificateState(row),
        issuedAt: row.issuedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        retainedUntil: row.retainUntil.toISOString(),
      })),
      canManage,
    },
  };
}

export async function createTrainingCourse(input: {
  associationId: string;
  code: string;
  title: string;
  version?: string;
  description?: string;
  passingScore: number;
  requiredAttendancePct: number;
  validityMonths: number;
  retentionYears: number;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = trainingCourseSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const association = await db.association.findFirst({
    where: { id: values.associationId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!association) return { success: false, error: "That association was not found." };

  const version = values.version?.trim() || "1";
  const duplicate = await db.trainingCourse.findFirst({
    where: { associationId: values.associationId, code: values.code, version },
    select: { id: true },
  });
  if (duplicate) {
    return { success: false, error: "That course code and version already exist." };
  }

  await db.$transaction(async (tx) => {
    const course = await tx.trainingCourse.create({
      data: {
        tenantId: ctx.tenantId,
        associationId: values.associationId,
        code: values.code,
        title: values.title,
        version,
        description: values.description || null,
        passingScore: values.passingScore,
        requiredAttendancePct: values.requiredAttendancePct,
        validityMonths: values.validityMonths,
        retentionYears: values.retentionYears,
        createdById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.course_created",
      entityType: "trainingCourse",
      entityId: course.id,
      details: {
        associationId: values.associationId,
        code: values.code,
        version,
        financialMutation: false,
      },
    });
  });
  return getTrainingOverview();
}

export async function publishTrainingCourse(input: {
  courseId: string;
  publish: boolean;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const course = await db.trainingCourse.findFirst({
    where: { id: input.courseId, tenantId: ctx.tenantId },
    include: { modules: { select: { id: true } } },
  });
  if (!course) return { success: false, error: "That course was not found." };
  if (input.publish && course.modules.length === 0) {
    return { success: false, error: "Add at least one module before publishing." };
  }
  await db.$transaction(async (tx) => {
    await tx.trainingCourse.update({
      where: { id: course.id },
      data: { status: input.publish ? "published" : "draft" },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: input.publish ? "training.course_published" : "training.course_unpublished",
      entityType: "trainingCourse",
      entityId: course.id,
      details: { code: course.code, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

export async function addTrainingModule(input: {
  courseId: string;
  position: number;
  title: string;
  content?: string;
  resourceUrl?: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = trainingModuleSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const course = await db.trainingCourse.findFirst({
    where: { id: values.courseId, tenantId: ctx.tenantId },
    select: { id: true, status: true, code: true },
  });
  if (!course) return { success: false, error: "That course was not found." };

  await db.$transaction(async (tx) => {
    const createdModule = await tx.trainingModule.create({
      data: {
        tenantId: ctx.tenantId,
        courseId: values.courseId,
        position: values.position,
        title: values.title,
        content: values.content || null,
        resourceUrl: values.resourceUrl || null,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.module_added",
      entityType: "trainingModule",
      entityId: createdModule.id,
      details: { courseId: values.courseId, position: values.position, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

export async function scheduleTrainingSession(input: {
  courseId: string;
  title: string;
  scheduledAt: string;
  durationMinutes: number;
  location?: string;
  trainerName?: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = trainingSessionSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const scheduledAt = new Date(values.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    return { success: false, error: "The date and time are invalid." };
  }
  const course = await db.trainingCourse.findFirst({
    where: { id: values.courseId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!course) return { success: false, error: "That course was not found." };

  await db.$transaction(async (tx) => {
    const session = await tx.trainingSession.create({
      data: {
        tenantId: ctx.tenantId,
        courseId: values.courseId,
        title: values.title,
        scheduledAt,
        durationMinutes: values.durationMinutes,
        location: values.location || null,
        trainerName: values.trainerName || null,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.session_scheduled",
      entityType: "trainingSession",
      entityId: session.id,
      details: { courseId: values.courseId, scheduledAt: scheduledAt.toISOString(), financialMutation: false },
    });
  });
  return getTrainingOverview();
}

/**
 * Mark a session as held.
 *
 * Completion counts only attended sessions that were actually held, so this is
 * the step that makes attendance meaningful.
 */
export async function markTrainingSessionHeld(input: {
  sessionId: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const session = await db.trainingSession.findFirst({
    where: { id: input.sessionId, tenantId: ctx.tenantId },
    select: { id: true, courseId: true, status: true },
  });
  if (!session) return { success: false, error: "That session was not found." };
  if (session.status !== "scheduled") {
    return { success: false, error: "Only a scheduled session can be marked as held." };
  }
  await db.$transaction(async (tx) => {
    await tx.trainingSession.update({
      where: { id: session.id },
      data: { status: "held" },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.session_held",
      entityType: "trainingSession",
      entityId: session.id,
      details: { courseId: session.courseId, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

export async function enrolLearner(input: {
  courseId: string;
  memberId?: string | null;
  userId?: string | null;
  learnerName: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = enrolmentSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const course = await db.trainingCourse.findFirst({
    where: { id: values.courseId, tenantId: ctx.tenantId },
    select: { id: true, status: true },
  });
  if (!course) return { success: false, error: "That course was not found." };
  if (course.status !== "published") {
    return { success: false, error: "Publish the course before enrolling anyone." };
  }
  if (values.memberId) {
    const member = await db.associationMember.findFirst({
      where: { id: values.memberId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!member) return { success: false, error: "That member was not found." };
  }
  if (values.userId) {
    const user = await db.user.findFirst({
      where: { id: values.userId, tenantId: ctx.tenantId, status: "active" },
      select: { id: true },
    });
    if (!user) return { success: false, error: "That staff user is not active here." };
  }

  const duplicate = await db.trainingEnrolment.findFirst({
    where: {
      courseId: values.courseId,
      memberId: values.memberId || null,
      userId: values.userId || null,
    },
    select: { id: true },
  });
  if (duplicate) {
    return { success: false, error: "That learner is already enrolled on this course." };
  }

  await db.$transaction(async (tx) => {
    const enrolment = await tx.trainingEnrolment.create({
      data: {
        tenantId: ctx.tenantId,
        courseId: values.courseId,
        memberId: values.memberId || null,
        userId: values.userId || null,
        learnerName: values.learnerName,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.learner_enrolled",
      entityType: "trainingEnrolment",
      entityId: enrolment.id,
      details: { courseId: values.courseId, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

export async function recordTrainingAttendance(input: {
  sessionId: string;
  enrolmentId: string;
  minutes: number;
  note?: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = attendanceSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const session = await db.trainingSession.findFirst({
    where: { id: values.sessionId, tenantId: ctx.tenantId },
    select: { id: true, courseId: true, durationMinutes: true, status: true },
  });
  if (!session) return { success: false, error: "That session was not found." };
  const enrolment = await db.trainingEnrolment.findFirst({
    where: { id: values.enrolmentId, tenantId: ctx.tenantId },
    select: { id: true, courseId: true },
  });
  if (!enrolment) return { success: false, error: "That enrolment was not found." };
  if (enrolment.courseId !== session.courseId) {
    return { success: false, error: "That learner is not enrolled on this course." };
  }
  if (values.minutes > session.durationMinutes) {
    return {
      success: false,
      error: `The session lasts ${session.durationMinutes} minutes, so attendance cannot exceed that.`,
    };
  }

  await db.$transaction(async (tx) => {
    const existing = await tx.trainingAttendance.findFirst({
      where: { sessionId: values.sessionId, enrolmentId: values.enrolmentId },
      select: { id: true },
    });
    if (existing) {
      await tx.trainingAttendance.update({
        where: { id: existing.id },
        data: {
          minutes: values.minutes,
          note: values.note || null,
          markedById: ctx.userId,
          attendedAt: new Date(),
        },
      });
    } else {
      await tx.trainingAttendance.create({
        data: {
          tenantId: ctx.tenantId,
          sessionId: values.sessionId,
          enrolmentId: values.enrolmentId,
          minutes: values.minutes,
          markedById: ctx.userId,
          note: values.note || null,
        },
      });
    }
    if (values.minutes > 0) {
      await tx.trainingEnrolment.updateMany({
        where: { id: values.enrolmentId, status: "enrolled" },
        data: { status: "in_progress" },
      });
    }
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.attendance_recorded",
      entityType: "trainingEnrolment",
      entityId: values.enrolmentId,
      details: {
        sessionId: values.sessionId,
        minutes: values.minutes,
        financialMutation: false,
      },
    });
  });
  return getTrainingOverview();
}

export async function createTrainingAssessment(input: {
  courseId: string;
  title: string;
  maxScore: number;
  passingScore: number;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const course = await db.trainingCourse.findFirst({
    where: { id: input.courseId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!course) return { success: false, error: "That course was not found." };
  if (!input.title.trim()) return { success: false, error: "Give the assessment a title." };
  if (
    !Number.isInteger(input.maxScore) ||
    input.maxScore <= 0 ||
    !Number.isInteger(input.passingScore) ||
    input.passingScore <= 0 ||
    input.passingScore > input.maxScore
  ) {
    return { success: false, error: "The pass mark must be between 1 and the maximum score." };
  }

  await db.$transaction(async (tx) => {
    const assessment = await tx.trainingAssessment.create({
      data: {
        tenantId: ctx.tenantId,
        courseId: input.courseId,
        title: input.title.trim(),
        maxScore: input.maxScore,
        passingScore: input.passingScore,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.assessment_created",
      entityType: "trainingAssessment",
      entityId: assessment.id,
      details: { courseId: input.courseId, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

/**
 * Record one assessment attempt.
 *
 * The pass result is computed from the assessment's own pass mark, and a course
 * is completed the moment the learner satisfies both the attendance and the
 * assessment criteria. Nothing here lets a caller assert "completed".
 */
export async function recordTrainingAttempt(input: {
  assessmentId: string;
  enrolmentId: string;
  score: number;
  assessorName?: string;
  note?: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = attemptSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const values = parsed.data;
  const assessment = await db.trainingAssessment.findFirst({
    where: { id: values.assessmentId, tenantId: ctx.tenantId },
    select: { id: true, courseId: true, maxScore: true, passingScore: true },
  });
  if (!assessment) return { success: false, error: "That assessment was not found." };
  if (values.score > assessment.maxScore) {
    return {
      success: false,
      error: `The maximum score for this assessment is ${assessment.maxScore}.`,
    };
  }
  const enrolment = await db.trainingEnrolment.findFirst({
    where: { id: values.enrolmentId, tenantId: ctx.tenantId },
    select: { id: true, courseId: true, status: true },
  });
  if (!enrolment) return { success: false, error: "That enrolment was not found." };
  if (enrolment.courseId !== assessment.courseId) {
    return { success: false, error: "That learner is not enrolled on this course." };
  }
  if (enrolment.status === "withdrawn") {
    return { success: false, error: "That learner has withdrawn from the course." };
  }
  const passed = values.score >= assessment.passingScore;

  await db.$transaction(async (tx) => {
    await tx.trainingAssessmentAttempt.create({
      data: {
        tenantId: ctx.tenantId,
        assessmentId: values.assessmentId,
        enrolmentId: values.enrolmentId,
        score: values.score,
        passed,
        assessorName: values.assessorName || null,
        note: values.note || null,
      },
    });

    const course = await tx.trainingCourse.findFirstOrThrow({
      where: { id: assessment.courseId },
      select: { passingScore: true, requiredAttendancePct: true },
    });
    const sessions = await tx.trainingSession.findMany({
      where: { courseId: assessment.courseId, status: "held" },
      select: { id: true },
    });
    const attendance = await tx.trainingAttendance.findMany({
      where: { enrolmentId: values.enrolmentId },
      select: { sessionId: true, minutes: true },
    });
    const heldIds = new Set(sessions.map((session) => session.id));
    const attended = new Set(
      attendance
        .filter((row) => heldIds.has(row.sessionId) && row.minutes > 0)
        .map((row) => row.sessionId)
    ).size;
    const attempts = await tx.trainingAssessmentAttempt.findMany({
      where: { enrolmentId: values.enrolmentId },
      select: { score: true },
    });
    const bestScore = Math.max(...attempts.map((row) => row.score));
    const completion = evaluateCompletion({
      requiredAttendancePct: course.requiredAttendancePct,
      passingScore: course.passingScore,
      sessionsHeld: sessions.length,
      sessionsAttended: attended,
      bestScore,
    });
    await tx.trainingEnrolment.update({
      where: { id: values.enrolmentId },
      data: {
        status: completion.complete ? "completed" : "in_progress",
        completedAt: completion.complete ? new Date() : null,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.attempt_recorded",
      entityType: "trainingEnrolment",
      entityId: values.enrolmentId,
      details: {
        assessmentId: values.assessmentId,
        score: values.score,
        passed,
        completed: completion.complete,
        blockers: completion.reasons,
        financialMutation: false,
      },
    });
  });
  return getTrainingOverview();
}

/**
 * Issue a certificate for a completed enrolment.
 *
 * Refused when the learner is not completed, when one already exists, or when the
 * course is retired. The token is random and unique, and the serial is readable.
 */
export async function issueTrainingCertificate(input: {
  enrolmentId: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const enrolment = await db.trainingEnrolment.findFirst({
    where: { id: input.enrolmentId, tenantId: ctx.tenantId },
    include: {
      certificate: { select: { id: true } },
      course: {
        select: {
          id: true,
          code: true,
          status: true,
          validityMonths: true,
          retentionYears: true,
        },
      },
    },
  });
  if (!enrolment) return { success: false, error: "That enrolment was not found." };
  if (enrolment.status !== "completed") {
    return {
      success: false,
      error: "A certificate is issued only after the learner has completed the course.",
    };
  }
  if (enrolment.certificate) {
    return { success: false, error: "That learner already has a certificate for this course." };
  }
  if (enrolment.course.status === "retired") {
    return { success: false, error: "This course is retired and cannot issue certificates." };
  }

  const issuedAt = new Date();
  const sequence =
    (await db.trainingCertificate.count({
      where: { tenantId: ctx.tenantId, serial: { startsWith: `${enrolment.course.code}-${issuedAt.getUTCFullYear()}-` } },
    })) + 1;
  const serial = certificateSerial(enrolment.course.code, issuedAt, sequence);
  const expiresAt = certificateExpiry(issuedAt, enrolment.course.validityMonths);
  const retainUntil = certificateRetention(expiresAt, enrolment.course.retentionYears);
  const verificationToken = randomBytes(24).toString("hex");

  await db.$transaction(async (tx) => {
    const certificate = await tx.trainingCertificate.create({
      data: {
        tenantId: ctx.tenantId,
        enrolmentId: enrolment.id,
        serial,
        verificationToken,
        issuedAt,
        expiresAt,
        retainUntil,
        issuedById: ctx.userId,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.certificate_issued",
      entityType: "trainingCertificate",
      entityId: certificate.id,
      details: {
        serial,
        courseCode: enrolment.course.code,
        expiresAt: expiresAt.toISOString(),
        financialMutation: false,
      },
    });
  });
  return getTrainingOverview();
}

export async function revokeTrainingCertificate(input: {
  certificateId: string;
  reason: string;
}): Promise<TrainingResponse> {
  const ctx = await requireTenantAdmin();
  const parsed = certificateRevokeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Check the values." };
  }
  const certificate = await db.trainingCertificate.findFirst({
    where: { id: parsed.data.certificateId, tenantId: ctx.tenantId },
    select: { id: true, serial: true, status: true },
  });
  if (!certificate) return { success: false, error: "That certificate was not found." };
  if (certificate.status === "revoked") {
    return { success: false, error: "That certificate is already revoked." };
  }
  await db.$transaction(async (tx) => {
    await tx.trainingCertificate.update({
      where: { id: certificate.id },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedById: ctx.userId,
        revokedReason: parsed.data.reason,
      },
    });
    await createAuditLogTx(tx, {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "training.certificate_revoked",
      entityType: "trainingCertificate",
      entityId: certificate.id,
      details: { serial: certificate.serial, reason: parsed.data.reason, financialMutation: false },
    });
  });
  return getTrainingOverview();
}

/** A learner's transcript: every course, attempt and certificate they hold. */
export async function getLearnerTranscript(input: {
  memberId?: string | null;
  userId?: string | null;
}): Promise<{
  success: boolean;
  error?: string;
  learnerName?: string;
  rows?: Array<{
    courseTitle: string;
    status: string;
    attendancePct: number;
    bestScore: number | null;
    certificateSerial: string | null;
    certificateState: string | null;
    expiresAt: string | null;
  }>;
}> {
  const ctx = await requireTenantAdmin();
  if (!input.memberId && !input.userId) {
    return { success: false, error: "Choose a learner." };
  }
  const enrolments = await db.trainingEnrolment.findMany({
    where: {
      tenantId: ctx.tenantId,
      ...(input.memberId ? { memberId: input.memberId } : { userId: input.userId }),
    },
    include: {
      course: {
        select: {
          title: true,
          passingScore: true,
          requiredAttendancePct: true,
          sessions: { select: { id: true, status: true } },
        },
      },
      attendance: { select: { sessionId: true, minutes: true } },
      attempts: { select: { score: true } },
      certificate: {
        select: { serial: true, status: true, issuedAt: true, expiresAt: true, revokedAt: true },
      },
    },
  });
  if (enrolments.length === 0) {
    return { success: false, error: "That learner has no training records here." };
  }
  return {
    success: true,
    learnerName: enrolments[0].learnerName,
    rows: enrolments.map((row) => {
      const heldIds = new Set(
        row.course.sessions.filter((session) => session.status === "held").map((s) => s.id)
      );
      const attended = new Set(
        row.attendance
          .filter((a) => heldIds.has(a.sessionId) && a.minutes > 0)
          .map((a) => a.sessionId)
      ).size;
      const bestScore = row.attempts.length
        ? Math.max(...row.attempts.map((attempt) => attempt.score))
        : null;
      const completion = evaluateCompletion({
        requiredAttendancePct: row.course.requiredAttendancePct,
        passingScore: row.course.passingScore,
        sessionsHeld: heldIds.size,
        sessionsAttended: attended,
        bestScore,
      });
      return {
        courseTitle: row.course.title,
        status: row.status,
        attendancePct: completion.attendancePct,
        bestScore,
        certificateSerial: row.certificate?.serial ?? null,
        certificateState: row.certificate ? certificateState(row.certificate) : null,
        expiresAt: row.certificate?.expiresAt.toISOString() ?? null,
      };
    }),
  };
}

/**
 * The public verification lookup.
 *
 * Answers with the course, serial, dates and state only: no contact details, no
 * learner reference, and a masked holder name.
 */
export async function verifyTrainingCertificate(token: string): Promise<{
  found: boolean;
  state: string;
  stateLabel: string;
  courseTitle?: string;
  version?: string;
  holder?: string;
  serial?: string;
  issuedAt?: string;
  expiresAt?: string;
}> {
  const { CERTIFICATE_STATE_LABELS, maskLearnerName: mask, certificateState: stateOf } =
    await import("@/lib/training");
  if (!/^[0-9a-f]{16,64}$/.test(token)) {
    return { found: false, state: "unknown", stateLabel: CERTIFICATE_STATE_LABELS.unknown };
  }
  const row = await db.trainingCertificate.findFirst({
    where: { verificationToken: token },
    include: {
      enrolment: {
        select: {
          learnerName: true,
          course: { select: { title: true, version: true } },
        },
      },
    },
  });
  if (!row) {
    return { found: false, state: "unknown", stateLabel: CERTIFICATE_STATE_LABELS.unknown };
  }
  const state = stateOf(row);
  return {
    found: true,
    state,
    stateLabel: CERTIFICATE_STATE_LABELS[state],
    courseTitle: row.enrolment.course.title,
    version: row.enrolment.course.version,
    holder: mask(row.enrolment.learnerName),
    serial: row.serial,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
