export function researchReportFormat(filePath) {
  const extension = /\.(pdf|pptx)$/i.exec(filePath)?.[1];
  return extension?.toLowerCase() ?? null;
}
