# Kubernetes deployment (Helm)

There is one Helm chart per service, and each service is its **own Helm release**. You can deploy, upgrade or roll back any service at any time without touching the others. [helmfile](https://github.com/helmfile/helmfile) deploys all of them, or any subset, with one command.

```
deploy/helm/
  helmfile.yaml.gotmpl      the six releases (namespace ecommerce-analytics)
  environments/local/       per-release values for one environment (copy it for staging, production)
  charts/
    ecommerce-analytics-lib/         library chart: the templates every service chart shares
    gateway/  auth-service/  product-service/  campaign-service/  analytics-service/  spark-streaming/
      Chart.yaml            the chart's version and its dependency on ecommerce-analytics-lib
      values.yaml           everything you can set for this service
      templates/manifests.yaml
```

The releases don't wait for each other. A service whose database, Kafka or ClickHouse isn't reachable yet keeps restarting or stays unready until it is, and then joins on its own. So the order doesn't matter, and redeploying one service never redeploys another.

## Prerequisites

- **Kubernetes 1.27+, Helm 3 and helmfile 1.x**, plus the helm-diff plugin, which `helmfile apply` and `diff` use (`helm plugin install https://github.com/databus23/helm-diff`). Helm alone is enough for a single service ([below](#with-helm-only)).
- **Images in a registry the cluster can pull from.** From `backend/`:

  ```bash
  docker build --build-arg SERVICE=gateway -t <registry>/ecommerce-analytics/gateway:<version> .   # repeat per Node service
  docker build --target runtime -t <registry>/ecommerce-analytics/spark-streaming:<version> streaming
  ```

- **Postgres, Kafka and ClickHouse** must already exist; the charts don't install them. Postgres needs the roles and databases from `infra/postgres/init.sql`, and ClickHouse needs `infra/clickhouse/init.sql`. The charts expect the hosts `postgres`, `kafka:19092` and `clickhouse` (the compose names). To use other hosts, set `config.KAFKA_BROKERS` and `config.KAFKA_BOOTSTRAP_SERVERS` (Spark), the connection strings under `secrets`, and `config.CLICKHOUSE_HOST`.

## Before the first deploy

All services verify tokens with the same key pair, so it lives in one Secret that no chart owns. That way no release depends on another release to create it:

```bash
kubectl create namespace ecommerce-analytics
kubectl -n ecommerce-analytics create secret generic ecommerce-analytics-jwt \
  --from-file=jwt-public.pem=keys/jwt-public.pem \
  --from-file=jwt-private.pem=keys/jwt-private.pem      # from backend/; `npm run keys` creates them
```

Only auth-service mounts `jwt-private.pem`; the other services get only the public key.

## Deploy

From `deploy/helm/`:

```bash
helmfile -e local apply                                  # every service
helmfile -e local -l name=gateway apply                  # one service
helmfile -e local -l name=auth-service -l name=gateway apply             # several
helmfile -e local -l name=gateway apply --set image.tag=1.4.2            # a new version of one service
helmfile -e local -l name=gateway diff                   # what an apply would change
```

`apply` installs or upgrades and waits for the pods to be ready. If they never become ready, it rolls that release back. The release for each name has the same name, so `helm -n ecommerce-analytics history gateway` and `helm -n ecommerce-analytics rollback gateway` work as usual.

To remove one service, run `helmfile -e local -l name=gateway destroy`, or `helm -n ecommerce-analytics uninstall gateway`.

### With Helm only

```bash
helm dependency build charts/gateway       # packages ecommerce-analytics-lib into charts/gateway/charts/
helm upgrade --install gateway charts/gateway -n ecommerce-analytics \
  -f environments/local/gateway.yaml --wait --atomic
```

Run `helm dependency build` again after changing `charts/ecommerce-analytics-lib`. helmfile does this on every `apply`.

## Environments

An environment is a folder of values files, one per release, applied on top of the chart's `values.yaml`. The `local` environment uses the `docker compose build` images (`ecommerce-analytics-<service>:latest`), one replica each, and the compose development credentials. Its target is a local cluster that can reach the compose infrastructure under the names above.

To add production, copy the folder and register it in `helmfile.yaml.gotmpl` under `environments:` (`production: {}`). Then, in each file:
- set `image.repository` and `image.tag`;
- replace the `secrets` values with `existingSecret: <a Secret you manage>`, for example from External Secrets or Sealed Secrets, with the same keys. No passwords then go into Git or into Helm's release history;
- for the gateway, enable `ingress` and set `config.CORS_ORIGINS` to the frontend's origin;
- set `config.KAFKA_REPLICATION: "3"` on a three-broker Kafka;
- set the replicas, or `autoscaling.enabled: true`.

## What every chart sets up

| | |
|---|---|
| **Probes** | startup `/health/startup` (up to 5 min for migrations), liveness `/health/live`, readiness `/health/ready` (database or ClickHouse, plus Kafka) |
| **Rollouts** | `maxUnavailable: 0`: an old pod stops only after its replacement is ready. On `SIGTERM` a pod fails readiness, drains for 5 s, then finishes in-flight requests within the 35 s grace period |
| **Availability** | a PodDisruptionBudget (one pod down at a time) once there are 2+ replicas; pods spread across nodes where possible |
| **Security** | non-root (UID 1000; 185 for Spark), read-only root filesystem with an in-memory `/tmp`, all capabilities dropped, `RuntimeDefault` seccomp, no Kubernetes API token |
| **Config** | `config` → ConfigMap, `secrets` → Secret (or `existingSecret`), both as environment variables. A changed value restarts the pods; a changed `existingSecret` doesn't, so run `kubectl rollout restart` after rotating it |
| **Autoscaling** | `autoscaling.enabled` adds an HPA on CPU (Node services) |

**spark-streaming** is a single-pod StatefulSet with a 5 Gi volume for its checkpoint (Kafka offsets and duplicate-drop state). A StatefulSet never runs a second copy while the first is still stopping, which a Deployment can do during a node drain. Two copies would write the same checkpoint. The chart refuses `replicaCount` other than 1. The volume survives `helm uninstall`; to start from scratch, delete the PVC `data-spark-streaming-0`. That replays Kafka from `KAFKA_STARTING_OFFSETS` (see `streaming/README.md` before doing it).

## Things to know

- **Rate limits are per pod.** The gateway counts requests in memory, so with 3 replicas a client can make up to 3× `RATE_LIMIT_PER_MINUTE`. It trusts one `X-Forwarded-For` hop for the client IP, so put exactly one proxy, the Ingress controller, in front of it.
- **Migrations run at startup in every pod.** On a fresh install with several replicas, the pods can race on the first migration. A pod that loses the race exits and restarts, and then finds the migration applied. Upgrades roll out one new pod at a time, so they don't race.
- **Topics are created by the services.** analytics-service creates the `analytics.*` topics that Spark reads. Spark deployed first simply waits for them.
