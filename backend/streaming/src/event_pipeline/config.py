from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    kafka_bootstrap_servers: str = "localhost:9092"
    # Prepended to topic names by analytics-service (KAFKA_TOPIC_PREFIX); usually empty.
    kafka_topic_prefix: str = ""
    # Prefix of the consumer group ids Spark's Kafka consumers use (for broker
    # logs and ACLs). Progress is not committed to Kafka; it lives in the checkpoint.
    kafka_group_id: str = "events-to-clickhouse"
    # Used only for a new query (no checkpoint yet).
    kafka_starting_offsets: str = "earliest"
    kafka_max_offsets_per_trigger: int = 200_000

    spark_trigger_interval: str = "30 seconds"
    # Used by the (tenant_id, event_name) shuffle in prepare_batch, i.e. how many
    # ClickHouse inserts a micro-batch is split into (at most, before chunking).
    spark_shuffle_partitions: int = 4
    checkpoint_location: str = "./var/checkpoints/events-to-clickhouse"

    clickhouse_host: str = "localhost"
    clickhouse_port: int = 8123
    clickhouse_username: str = "default"
    clickhouse_password: str = ""
    clickhouse_database: str = "analytics"
    clickhouse_table: str = "events"
    clickhouse_secure: bool = False
    clickhouse_insert_batch_size: int = 5_000

    @property
    def kafka_topic_pattern(self) -> str:
        """Every analytics.<eventName>.v1 topic, including ones created later."""
        return rf"^{self.kafka_topic_prefix}analytics\..+\.v1$"


settings = Settings()
