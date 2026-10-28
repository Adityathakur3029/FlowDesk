import type { Request, Response } from "express";
import * as reportService from "./report.service";
import { overviewReportQuerySchema } from "./report.validation";

// GET /reports/overview?from=&to=
export async function overview(req: Request, res: Response): Promise<void> {
  const query = overviewReportQuerySchema.parse(req.query);
  const report = await reportService.getOverviewReport(query);
  res.json({ data: report });
}
