/**
 * @typedef {Object} Attachment
 * @property {string} filename
 * @property {string} path
 * @property {string} mimeType
 * @property {number} sizeBytes
 */

/**
 * @typedef {Object} Classification
 * @property {boolean} isAccountingDocument
 * @property {number} confidence
 * @property {string} docType
 * @property {string} paymentMethod
 * @property {string} reason
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {string} filename
 * @property {boolean} isAccountingDocument
 * @property {number} confidence
 * @property {string} docType
 * @property {string} [paymentMethod]
 * @property {string} reason
 * @property {boolean} uploaded
 */

/**
 * @typedef {Object} EmailMessage
 * @property {string} emailId
 * @property {string} subject
 * @property {string} from
 * @property {Date} receivedDate
 * @property {string} bodyText
 * @property {string} [bodyHtml]
 * @property {Attachment[]} attachments
 */

/**
 * @typedef {Object} ProcessResult
 * @property {string} emailId
 * @property {string} subject
 * @property {boolean} success
 * @property {ClassificationResult[]} [classifications]
 * @property {number} [uploadedCount]
 * @property {string[]} [uploadedNames]
 * @property {boolean} [skipped]
 * @property {string} [skipReason]
 * @property {string} [error]
 */

/**
 * @typedef {Object} EmailConfig
 * @property {string} host
 * @property {number} port
 * @property {boolean} [secure]
 * @property {string} user
 * @property {string} password
 * @property {string} [processedLabel]
 * @property {string} [skippedFolder]
 */

/**
 * @typedef {Object} TriviConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} baseUrl
 * @property {string} [uploadsPath]
 * @property {string} [scansPath]
 * @property {string} [uploadFieldName]
 */

/**
 * @typedef {Object} MistralConfig
 * @property {string} apiKey
 * @property {string} [classifierModel]
 * @property {number} uploadThreshold
 */

/**
 * @typedef {Object} NotificationConfig
 * @property {string} snsTopicArn
 * @property {string} adminEmail
 */

/**
 * @typedef {Object} S3Config
 * @property {string} bucketName
 */

/**
 * @typedef {Object} AppConfig
 * @property {EmailConfig} email
 * @property {TriviConfig} trivi
 * @property {MistralConfig} [mistral]
 * @property {NotificationConfig} [notification]
 * @property {S3Config} [s3]
 */

/**
 * @typedef {Object} UploadMetadata
 * @property {string} [subject]
 * @property {string} [from]
 * @property {string} [receivedDate]
 * @property {Partial<Classification>} [classification]
 */

/**
 * @typedef {Object} UploadResult
 * @property {string} fileId
 * @property {*} scan
 */

/**
 * @typedef {Object} Services
 * @property {AppConfig} cfg
 * @property {*} trivi
 * @property {*} email
 * @property {*} storage
 * @property {*} notification
 * @property {*} [classifier]
 */

export {};
