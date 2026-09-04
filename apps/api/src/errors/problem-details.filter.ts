import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { mapErrorToProblem } from "./problem-details";

/**
 * Global RFC 9457 (`application/problem+json`) exception filter (task 5.3).
 * `@Catch()` with no argument catches everything thrown anywhere in the
 * request pipeline — including errors thrown by ports the use case calls —
 * and maps them via the pure `mapErrorToProblem` table. Wired globally in
 * main.ts (see main.ts's own comment for why there, not `APP_FILTER`).
 *
 * Intentionally thin: all mapping logic lives in the pure, directly
 * unit-tested `mapErrorToProblem`; this class only adapts that result onto
 * the real Express response (status code, headers, JSON body,
 * `application/problem+json` content type).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const problem = mapErrorToProblem(exception);

    for (const [header, value] of Object.entries(problem.headers ?? {})) {
      response.setHeader(header, value);
    }

    response
      .status(problem.status)
      .contentType("application/problem+json")
      .json({ type: problem.type, title: problem.title, status: problem.status, ...problem.extra });
  }
}
