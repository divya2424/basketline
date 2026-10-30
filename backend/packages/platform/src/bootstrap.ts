import type { EventBus } from '@divya2424/basketline-kafka'
import { listEnv, optionalEnv } from './config.ts'
import { createKafkaEventBus, ensureTopics, type TopicSpec } from '@divya2424/basketline-kafka'
import type { Logger } from './logger.ts'

/** Kafka bus from KAFKA_BROKERS / KAFKA_TOPIC_PREFIX; exits on a fatal consumer error. */
export async function createBusFromEnv(clientId: string, logger: Logger, producesTopics: TopicSpec[] = []): Promise<EventBus> {
  const brokers = listEnv('KAFKA_BROKERS', ['localhost:9092'])
  const topicPrefix = optionalEnv('KAFKA_TOPIC_PREFIX', '')
  if (producesTopics.length > 0) await ensureTopics({ brokers, clientId, topicPrefix }, producesTopics)
  return createKafkaEventBus({
    brokers,
    clientId,
    topicPrefix,
    logger,
    onFatal: () => {
      // Let the orchestrator restart us; offsets were not committed for the failed message.
      process.exit(1)
    },
  })
}
