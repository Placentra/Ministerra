// OPENTELEMETRY BOOTSTRAP ------------------------------------------------------
// Steps: describe this process instance, configure OTLP exporter + auto-instrumentations, start SDK, then on SIGTERM shut down cleanly without owning process exit.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { getLogger } from './systems/handlers/logging/index';

const logger = getLogger('OTEL');

// RESOURCE IDENTITY ------------------------------------------------------------
// Steps: compute stable identifiers for service/version/instance so traces can be grouped across deploys and workers.
const serviceName = process.env.OTEL_SERVICE_NAME || 'backend';
const serviceVersion = process.env.APP_VERSION || '1.0.0';
const instanceId = `${serviceName}-${process.pid}`;

// OTEL RESOURCE ---------------------------------------------------------------
// Steps: attach resource attributes that exporters/backends rely on for service discovery.
const resource = new Resource({
	[SemanticResourceAttributes.SERVICE_NAME]: serviceName,
	[SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
	[SemanticResourceAttributes.SERVICE_INSTANCE_ID]: instanceId,
});

// EXPORTER ---------------------------------------------------------------------
// Steps: use OTLP gRPC exporter; endpoint/credentials are configured via standard OTEL env vars.
const exporter = new OTLPTraceExporter({});

// SDK --------------------------------------------------------------------------
// Steps: wire resource + exporter + selected instrumentations; keep the list explicit so instrumentation enablement stays reviewable.
const sdk = new NodeSDK({
	resource,
	traceExporter: exporter,
	instrumentations: [
		getNodeAutoInstrumentations({
			'@opentelemetry/instrumentation-http': { enabled: true },
			'@opentelemetry/instrumentation-express': { enabled: true },
			'@opentelemetry/instrumentation-mysql2': { enabled: true },
			'@opentelemetry/instrumentation-redis': { enabled: true },
			'@opentelemetry/instrumentation-socket.io': { enabled: true },
		}),
	],
});

// STARTUP ----------------------------------------------------------------------
// Steps: start SDK once at process boot; failures should log but should not crash the whole backend by themselves.
try { sdk.start(); } catch (err) { logger.error('otel.start_failed', { error: err }); }

// Do NOT call process.exit() here.
// The backend has its own unified shutdown path; OTEL should just flush/stop.
// SHUTDOWN ---------------------------------------------------------------------
// Steps: on SIGTERM, flush and shutdown SDK; avoid taking ownership of process lifecycle (the app handles exit ordering).
process.on('SIGTERM', async () => {
	try {
		await sdk.shutdown();
		logger.info('otel.tracing_terminated');
	} catch (err) {
		logger.error('otel.shutdown_failed', { error: err });
	}
});
