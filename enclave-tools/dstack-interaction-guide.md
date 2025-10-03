# Dstack Node Interaction Guide

This document explains how to interact with deployed CVMs in dstack through gateway URLs.

## Gateway URL Patterns

Each running CVM exposes services through dstack gateway using these URL patterns:

### Basic URL Structure
```
https://{app-id-or-instance-id}[-{port}].{gateway-domain}/
```

Where:
- `{app-id}` - The application ID (e.g., `c651380e78f32f161efcaaaba74f0dca208a980c`)
- `{instance-id}` - The instance ID (e.g., `fdde6541e7d2da83f02959d6c2d26605ae5ebf7b`)
- `{port}` - Optional port number (defaults to exposed ports)
- `{gateway-domain}` - Gateway domain (e.g., `dstack-base-prod7.phala.network`)

### URL Examples

For our deployment with:
- App ID: `c651380e78f32f161efcaaaba74f0dca208a980c`
- Instance ID: `fdde6541e7d2da83f02959d6c2d26605ae5ebf7b`
- Gateway: `dstack-base-prod7.phala.network`

#### Node Information (Port 8090)
```bash
# Node info page
https://c651380e78f32f161efcaaaba74f0dca208a980c-8090.dstack-base-prod7.phala.network/

# Or using instance ID
https://fdde6541e7d2da83f02959d6c2d26605ae5ebf7b-8090.dstack-base-prod7.phala.network/
```

#### Application Services (Port 3000)
```bash
# Main application endpoint - Uses INSTANCE ID, not APP ID
https://fdde6541e7d2da83f02959d6c2d26605ae5ebf7b-3000.dstack-base-prod7.phala.network/
```

**Important**: Application services use the **Instance ID** (`fdde6541e7d2da83f02959d6c2d26605ae5ebf7b`), while node info uses the **App ID** (`c651380e78f32f161efcaaaba74f0dca208a980c`).

## Service Logs

Access container logs using:
```
https://{app-id}-8090.{gateway-domain}/logs/{service-name}?{parameters}
```

### Parameters:
- `text` - Human-readable text instead of base64
- `bare` - Raw log lines without JSON format
- `timestamps` - Add timestamps to each log line
- `tail=N` - Show last N lines
- `since=TIMESTAMP` - Starting Unix timestamp
- `until=TIMESTAMP` - Ending Unix timestamp
- `follow` - Continuous log streaming

### Examples:
```bash
# Get tokscope-enclave service logs (last 20 lines with timestamps)
curl "https://c651380e78f32f161efcaaaba74f0dca208a980c-8090.dstack-base-prod7.phala.network/logs/tokscope-enclave?text&bare&timestamps&tail=20"

# Get browser-manager service logs
curl "https://c651380e78f32f161efcaaaba74f0dca208a980c-8090.dstack-base-prod7.phala.network/logs/browser-manager?text&bare&timestamps&tail=20"

# Follow live logs
curl "https://c651380e78f32f161efcaaaba74f0dca208a980c-8090.dstack-base-prod7.phala.network/logs/tokscope-enclave?text&bare&timestamps&follow"
```

## Finding Service Names

1. First, visit the node info page to see deployed containers:
   ```bash
   curl https://c651380e78f32f161efcaaaba74f0dca208a980c-8090.dstack-base-prod7.phala.network/
   ```

2. Look for the "Deployed Containers" table which shows actual service names

3. Use those exact names in the logs URL

## Common Commands

### Get CVM Information
```bash
# List all CVMs
phala cvms list

# Get specific CVM details
phala cvms info <app-id>
```

### Get Gateway Domain
Extract gateway domain from the "Node Info URL" in `phala cvms list` output.

### Check CVM Status
```bash
# Basic node info
curl https://{app-id}-8090.{gateway-domain}/

# Check if application is responding
curl https://{app-id}-3000.{gateway-domain}/health
```

## Troubleshooting

### SSL Issues
If you get SSL errors, try:
```bash
curl -k https://...  # Skip SSL verification
```

### Connection Issues
- Ensure the CVM status is "running"
- Wait 1-2 minutes after startup for services to fully initialize
- Check if the correct gateway domain is being used (base vs eth vs prod)

### Service Not Found
- Verify service names from the node info page
- Container names in docker-compose might differ from actual running names

## Our Current Deployment

- **App ID**: `c651380e78f32f161efcaaaba74f0dca208a980c`
- **Gateway**: `dstack-base-prod7.phala.network`
- **Services**: `tokscope-enclave`, `browser-manager`
- **Main App**: Port 3000
- **Node Info**: Port 8090