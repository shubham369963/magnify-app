export const UPLOAD_STATUS_QUERY = `
  query UploadStatus($jobId: ID!) { uploadStatus(jobId: $jobId) { status error } }
`;