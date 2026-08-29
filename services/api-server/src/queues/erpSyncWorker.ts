// TODO: Implement BullMQ worker for outbound order → ERP Sales Quotation
// - Process submitted orders (status SUBMITTED) from the queue
// - Push order payload to tenant's ERP endpoint with idempotency_key
// - Update order status: SYNCED_ERP on success, REJECTED_ERP on failure
// - Implement exponential backoff retry logic
// - Log all sync operations to audit_erp_sync_logs

export {}
