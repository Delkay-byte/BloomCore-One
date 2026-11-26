"use client";

import { useCallback, useEffect, useState } from "react";
import { Award, GraduationCap, RefreshCw } from "lucide-react";
import Notice from "@/components/ui/Notice";
import {
  createTrainingAssessment,
  createTrainingCourse,
  getTrainingOverview,
  issueTrainingCertificate,
  publishTrainingCourse,
  revokeTrainingCertificate,
  scheduleTrainingSession,
  type TrainingOverview,
} from "@/lib/actions/training.actions";
import { TRAINING_DISCLAIMER } from "@/lib/training";
import { getAssociationGovernance } from "@/lib/actions/association-governance.actions";

/**
 * Association training desk.
 *
 * Completion is shown as the rules compute it: attendance against sessions held,
 * best score against the pass mark, and the blockers in words. Certificates are
 * issued from a completed enrolment and nothing on this screen can assert
 * "completed" directly.
 */
export default function TrainingPanel() {
  const [view, setView] = useState<TrainingOverview | null>(null);
  const [associations, setAssociations] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [associationId, setAssociationId] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [passingScore, setPassingScore] = useState("70");
  const [attendancePct, setAttendancePct] = useState("80");
  const [validityMonths, setValidityMonths] = useState("12");
  const [retentionYears, setRetentionYears] = useState("5");

  const [sessionCourseId, setSessionCourseId] = useState("");
  const [sessionTitle, setSessionTitle] = useState("");
  const [sessionAt, setSessionAt] = useState("");
  const [sessionMinutes, setSessionMinutes] = useState("60");

  const [revokeReason, setRevokeReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [result, governance] = await Promise.all([
        getTrainingOverview(),
        getAssociationGovernance(),
      ]);
      const list = (governance.data?.associations ?? []).map((association) => ({
        id: association.id,
        name: association.name,
      }));
      setAssociations(list);
      setAssociationId((current) => current || list[0]?.id || "");
      if (!result.success || !result.data) {
        setError(result.error ?? "Training records could not be loaded.");
      } else {
        setView(result.data);
        setSessionCourseId((current) => current || result.data!.courses[0]?.id || "");
      }
    } catch {
      setError("Training records could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<{ success: boolean; error?: string }>, message: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    const result = await fn();
    if (!result.success) setError(result.error ?? "That action could not be completed.");
    else {
      setSuccess(message);
      await load();
    }
    setBusy(false);
  }

  if (loading && !view) {
    return <p className="text-sm text-slate-500">Loading training records…</p>;
  }

  return (
    <section className="space-y-4" aria-labelledby="training-desk">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="training-desk" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
            <GraduationCap size={18} aria-hidden /> Training and certification
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-slate-600">{TRAINING_DISCLAIMER}</p>
        </div>
        <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </header>

      {error && <Notice type="error">{error}</Notice>}
      {success && <Notice type="success">{success}</Notice>}

      {associations.length === 0 ? (
        <p className="card p-4 text-sm text-slate-500">
          Register an association first, then add courses to it.
        </p>
      ) : (
        <form
          className="card space-y-2 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                createTrainingCourse({
                  associationId,
                  code,
                  title,
                  passingScore: Number(passingScore),
                  requiredAttendancePct: Number(attendancePct),
                  validityMonths: Number(validityMonths),
                  retentionYears: Number(retentionYears),
                }),
              "Course created."
            );
          }}
        >
          <h3 className="text-sm font-semibold text-slate-900">New course</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <select
              value={associationId}
              onChange={(event) => setAssociationId(event.target.value)}
              className="input w-full"
              aria-label="Course association"
            >
              {associations.map((association) => (
                <option key={association.id} value={association.id}>
                  {association.name}
                </option>
              ))}
            </select>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="Course code"
              className="input w-full"
              aria-label="Course code"
            />
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Course title"
              className="input w-full sm:col-span-2"
              aria-label="Course title"
            />
            <label className="text-xs font-medium text-slate-600">
              Pass mark
              <input
                type="number"
                min="1"
                max="100"
                value={passingScore}
                onChange={(event) => setPassingScore(event.target.value)}
                className="input mt-1 w-full"
                aria-label="Pass mark"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Required attendance %
              <input
                type="number"
                min="0"
                max="100"
                value={attendancePct}
                onChange={(event) => setAttendancePct(event.target.value)}
                className="input mt-1 w-full"
                aria-label="Required attendance"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Certificate validity (months)
              <input
                type="number"
                min="1"
                max="120"
                value={validityMonths}
                onChange={(event) => setValidityMonths(event.target.value)}
                className="input mt-1 w-full"
                aria-label="Certificate validity months"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Keep evidence (years)
              <input
                type="number"
                min="1"
                max="20"
                value={retentionYears}
                onChange={(event) => setRetentionYears(event.target.value)}
                className="input mt-1 w-full"
                aria-label="Evidence retention years"
              />
            </label>
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
            Create course
          </button>
        </form>
      )}

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-900">Courses</h3>
        {view?.courses.length ? (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">Code</th>
                <th className="py-1">Title</th>
                <th className="py-1">State</th>
                <th className="py-1">Pass</th>
                <th className="py-1">Enrolled</th>
                <th className="py-1">Completed</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {view.courses.map((course) => (
                <tr key={course.id} className="border-t border-slate-100">
                  <td className="py-1 font-mono">{course.code}</td>
                  <td className="py-1">{course.title}</td>
                  <td className="py-1">{course.status}</td>
                  <td className="py-1">{course.passingScore}</td>
                  <td className="py-1">{course.enrolments}</td>
                  <td className="py-1">{course.completed}</td>
                  <td className="py-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () =>
                            publishTrainingCourse({
                              courseId: course.id,
                              publish: course.status !== "published",
                            }),
                          course.status === "published" ? "Course moved to draft." : "Course published."
                        )
                      }
                      className="btn btn-secondary btn-xs"
                    >
                      {course.status === "published" ? "Unpublish" : "Publish"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-xs text-slate-500">No courses yet.</p>
        )}
      </div>

      {view && view.courses.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(
                () =>
                  scheduleTrainingSession({
                    courseId: sessionCourseId,
                    title: sessionTitle,
                    scheduledAt: sessionAt,
                    durationMinutes: Number(sessionMinutes),
                  }),
                "Session scheduled."
              );
            }}
          >
            <h3 className="text-sm font-semibold text-slate-900">Schedule a session</h3>
            <select
              value={sessionCourseId}
              onChange={(event) => setSessionCourseId(event.target.value)}
              className="input w-full"
              aria-label="Session course"
            >
              {view.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code} · {course.title}
                </option>
              ))}
            </select>
            <input
              value={sessionTitle}
              onChange={(event) => setSessionTitle(event.target.value)}
              placeholder="Session title"
              className="input w-full"
              aria-label="Session title"
            />
            <input
              type="datetime-local"
              value={sessionAt}
              onChange={(event) => setSessionAt(event.target.value)}
              className="input w-full"
              aria-label="Session date and time"
            />
            <input
              type="number"
              min="15"
              max="480"
              value={sessionMinutes}
              onChange={(event) => setSessionMinutes(event.target.value)}
              className="input w-full"
              aria-label="Session minutes"
            />
            <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
              Schedule session
            </button>
          </form>

          <form
            className="card space-y-2 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              const assessmentId = (
                document.getElementById("assessment-course") as HTMLSelectElement | null
              )?.value;
              if (!assessmentId) return;
              void run(
                () =>
                  createTrainingAssessment({
                    courseId: assessmentId,
                    title: sessionTitle || "Final assessment",
                    maxScore: 100,
                    passingScore: Number(passingScore),
                  }),
                "Assessment added."
              );
            }}
          >
            <h3 className="text-sm font-semibold text-slate-900">Add an assessment</h3>
            <select
              id="assessment-course"
              className="input w-full"
              aria-label="Assessment course"
              defaultValue={view.courses[0]?.id}
            >
              {view.courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.code} · {course.title}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-slate-500">
              An assessment uses the course pass mark. Attempts are recorded against it and
              completion is computed from the best attempt.
            </p>
            <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
              Add assessment
            </button>
          </form>
        </div>
      )}

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-900">Learners</h3>
        {view?.enrolments.length ? (
          <table className="mt-2 w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1">Learner</th>
                <th className="py-1">Course</th>
                <th className="py-1">State</th>
                <th className="py-1">Attendance</th>
                <th className="py-1">Best score</th>
                <th className="py-1">Certificate</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {view.enrolments.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top">
                  <td className="py-1">{row.learnerName}</td>
                  <td className="py-1">{row.courseTitle}</td>
                  <td className="py-1">{row.status}</td>
                  <td className="py-1">{row.attendancePct}%</td>
                  <td className="py-1">
                    {row.bestScore === null ? "—" : `${row.bestScore}/${row.passingScore}`}
                  </td>
                  <td className="py-1">
                    {row.certificateSerial ? (
                      <span className="font-mono">
                        {row.certificateSerial} · {row.certificateState}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1 space-y-1">
                    {row.status === "completed" && !row.certificateSerial && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => issueTrainingCertificate({ enrolmentId: row.id }),
                            "Certificate issued."
                          )
                        }
                        className="btn btn-primary btn-xs"
                      >
                        <Award size={11} aria-hidden /> Issue certificate
                      </button>
                    )}
                    {row.blockers.length > 0 && (
                      <ul className="list-inside list-disc text-[11px] text-amber-700">
                        {row.blockers.map((blocker) => (
                          <li key={blocker}>{blocker}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-2 text-xs text-slate-500">Nobody is enrolled yet.</p>
        )}
      </div>

      {view?.certificates.length ? (
        <div className="card space-y-2 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Certificates</h3>
          <ul className="space-y-2 text-xs">
            {view.certificates.map((certificate) => (
              <li key={certificate.id} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{certificate.serial}</span>
                <span className="font-medium">{certificate.learnerName}</span>
                <span className="text-slate-500">{certificate.courseTitle}</span>
                <span className="badge badge-blue">{certificate.state}</span>
                <span className="text-slate-500">
                  expires {new Date(certificate.expiresAt).toLocaleDateString("en-GB")}
                </span>
                {certificate.state !== "revoked" && (
                  <button
                    type="button"
                    disabled={busy || revokeReason.trim().length < 10}
                    onClick={() =>
                      void run(
                        () =>
                          revokeTrainingCertificate({
                            certificateId: certificate.id,
                            reason: revokeReason,
                          }),
                        "Certificate revoked."
                      )
                    }
                    className="btn btn-secondary btn-xs"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
          <label className="block text-xs font-medium text-slate-600">
            Revocation reason (used by the Revoke buttons above)
            <input
              value={revokeReason}
              onChange={(event) => setRevokeReason(event.target.value)}
              className="input mt-1 w-full"
              placeholder="Why is the certificate being revoked?"
              aria-label="Revocation reason"
            />
          </label>
        </div>
      ) : null}

      <div className="card p-4 text-[11px] text-slate-500">
        Attendance is recorded per learner with the minutes attended, and only sessions marked
        as held count towards completion.
      </div>
    </section>
  );
}
