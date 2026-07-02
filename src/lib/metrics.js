const NAMESPACE = 'Diamondigital/InvoicesAgent';

export function emitMetrics(counts, now = Date.now()) {
  const payload = {
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [[]],
          Metrics: [
            { Name: 'EmailsProcessed', Unit: 'Count' },
            { Name: 'UploadsSuccessful', Unit: 'Count' },
            { Name: 'EmailsSkipped', Unit: 'Count' },
            { Name: 'UploadsFailed', Unit: 'Count' },
          ],
        },
      ],
    },
    EmailsProcessed: counts.processed,
    UploadsSuccessful: counts.successful,
    EmailsSkipped: counts.skipped,
    UploadsFailed: counts.failed,
  };

  console.log(JSON.stringify(payload));
  return payload;
}
