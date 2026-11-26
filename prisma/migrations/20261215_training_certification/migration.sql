-- CreateTable
CREATE TABLE "TrainingCourse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "associationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "requiredAttendancePct" INTEGER NOT NULL DEFAULT 80,
    "validityMonths" INTEGER NOT NULL DEFAULT 12,
    "retentionYears" INTEGER NOT NULL DEFAULT 5,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingModule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "courseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "resourceUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 60,
    "location" TEXT,
    "trainerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingEnrolment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "courseId" TEXT NOT NULL,
    "memberId" TEXT,
    "userId" TEXT,
    "learnerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'enrolled',
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingEnrolment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttendance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "sessionId" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 0,
    "attendedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "markedById" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAttendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAssessment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "maxScore" INTEGER NOT NULL DEFAULT 100,
    "passingScore" INTEGER NOT NULL DEFAULT 70,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAssessmentAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "assessmentId" TEXT NOT NULL,
    "enrolmentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessorName" TEXT,
    "note" TEXT,

    CONSTRAINT "TrainingAssessmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingCertificate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "enrolmentId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "retainUntil" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokedReason" TEXT,
    "issuedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingCourse_tenantId_status_idx" ON "TrainingCourse"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingCourse_associationId_code_version_key" ON "TrainingCourse"("associationId", "code", "version");

-- CreateIndex
CREATE INDEX "TrainingModule_courseId_idx" ON "TrainingModule"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingModule_courseId_position_key" ON "TrainingModule"("courseId", "position");

-- CreateIndex
CREATE INDEX "TrainingSession_tenantId_courseId_scheduledAt_idx" ON "TrainingSession"("tenantId", "courseId", "scheduledAt");

-- CreateIndex
CREATE INDEX "TrainingEnrolment_tenantId_status_idx" ON "TrainingEnrolment"("tenantId", "status");

-- CreateIndex
CREATE INDEX "TrainingEnrolment_courseId_learnerName_idx" ON "TrainingEnrolment"("courseId", "learnerName");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingEnrolment_courseId_memberId_userId_key" ON "TrainingEnrolment"("courseId", "memberId", "userId");

-- CreateIndex
CREATE INDEX "TrainingAttendance_enrolmentId_idx" ON "TrainingAttendance"("enrolmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttendance_sessionId_enrolmentId_key" ON "TrainingAttendance"("sessionId", "enrolmentId");

-- CreateIndex
CREATE INDEX "TrainingAssessment_courseId_idx" ON "TrainingAssessment"("courseId");

-- CreateIndex
CREATE INDEX "TrainingAssessmentAttempt_enrolmentId_attemptedAt_idx" ON "TrainingAssessmentAttempt"("enrolmentId", "attemptedAt");

-- CreateIndex
CREATE INDEX "TrainingAssessmentAttempt_assessmentId_idx" ON "TrainingAssessmentAttempt"("assessmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingCertificate_enrolmentId_key" ON "TrainingCertificate"("enrolmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingCertificate_verificationToken_key" ON "TrainingCertificate"("verificationToken");

-- CreateIndex
CREATE INDEX "TrainingCertificate_tenantId_status_expiresAt_idx" ON "TrainingCertificate"("tenantId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingCertificate_tenantId_serial_key" ON "TrainingCertificate"("tenantId", "serial");

-- AddForeignKey
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingCourse" ADD CONSTRAINT "TrainingCourse_associationId_fkey" FOREIGN KEY ("associationId") REFERENCES "Association"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModule" ADD CONSTRAINT "TrainingModule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingModule" ADD CONSTRAINT "TrainingModule_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrolment" ADD CONSTRAINT "TrainingEnrolment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrolment" ADD CONSTRAINT "TrainingEnrolment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingEnrolment" ADD CONSTRAINT "TrainingEnrolment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "AssociationMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TrainingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttendance" ADD CONSTRAINT "TrainingAttendance_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "TrainingEnrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessment" ADD CONSTRAINT "TrainingAssessment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessment" ADD CONSTRAINT "TrainingAssessment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "TrainingCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessmentAttempt" ADD CONSTRAINT "TrainingAssessmentAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessmentAttempt" ADD CONSTRAINT "TrainingAssessmentAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "TrainingAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAssessmentAttempt" ADD CONSTRAINT "TrainingAssessmentAttempt_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "TrainingEnrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingCertificate" ADD CONSTRAINT "TrainingCertificate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "BusinessTenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingCertificate" ADD CONSTRAINT "TrainingCertificate_enrolmentId_fkey" FOREIGN KEY ("enrolmentId") REFERENCES "TrainingEnrolment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

