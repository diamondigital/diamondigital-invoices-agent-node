const NAMESPACE = 'Diamondigital/InvoicesAgent';

export interface MetricCounts {
  processed: number;
  successful: number;
  skipped: number;
  failed: number;
}

export interface EmfMetricDefinition {
  Name: string;
  Unit: string;
}

export interface EmfCloudWatchMetrics {
  Namespace: string;
  Dimensions: string[][];
  Metrics: EmfMetricDefinition[];
}

export interface EmfPayload {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: EmfCloudWatchMetrics[];
  };
  EmailsProcessed: number;
  UploadsSuccessful: number;
  EmailsSkipped: number;
  UploadsFailed: number;
}

export function emitMetrics(counts: MetricCounts, now: number = Date.now()): EmfPayload {
  const payload: EmfPayload = {
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
