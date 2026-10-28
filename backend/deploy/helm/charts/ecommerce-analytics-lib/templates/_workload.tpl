{{/*
A Deployment, or a single-identity StatefulSet when .Values.persistence is set:
a StatefulSet never runs the old and new pod at the same time (a Deployment
can, during a node drain), which a checkpoint directory needs.
*/}}
{{- define "ecommerce-analytics.workload" -}}
{{- $fullname := include "ecommerce-analytics.fullname" . -}}
{{- $persistence := .Values.persistence -}}
{{- $jwt := .Values.jwt -}}
{{- $hasSecret := or .Values.secrets .Values.existingSecret -}}
{{- if and $persistence (ne (int .Values.replicaCount) 1) }}
{{- fail "replicaCount must be 1: the pod owns its persistent volume (one checkpoint, one writer)" }}
{{- end }}
---
apiVersion: apps/v1
kind: {{ ternary "StatefulSet" "Deployment" (not (empty $persistence)) }}
metadata:
  name: {{ $fullname }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
spec:
  {{- if not (.Values.autoscaling).enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      {{- include "ecommerce-analytics.selectorLabels" . | nindent 6 }}
  {{- if $persistence }}
  serviceName: {{ $fullname }}
  {{- else }}
  strategy:
    type: RollingUpdate
    # New pods must pass /health/ready before an old one is stopped.
    rollingUpdate:
      maxSurge: 25%
      maxUnavailable: 0
  {{- end }}
  template:
    metadata:
      labels:
        {{- include "ecommerce-analytics.selectorLabels" . | nindent 8 }}
      annotations:
        # Restart pods when the chart's config or secrets change.
        checksum/config: {{ toJson .Values.config | sha256sum }}
        checksum/secrets: {{ toJson .Values.secrets | sha256sum }}
        {{- with .Values.podAnnotations }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      serviceAccountName: {{ $fullname }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds | default 30 }}
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ .Values.runAsUser }}
        runAsGroup: {{ .Values.runAsUser }}
        fsGroup: {{ .Values.runAsUser }}
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile:
          type: RuntimeDefault
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              {{- include "ecommerce-analytics.selectorLabels" . | nindent 14 }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.affinity }}
      affinity:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ include "ecommerce-analytics.name" . }}
          image: "{{ .Values.image.repository }}:{{ include "ecommerce-analytics.imageTag" . }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: {{ .Values.readOnlyRootFilesystem }}
            capabilities:
              drop: ["ALL"]
          {{- if or .Values.port $jwt }}
          env:
            {{- with .Values.port }}
            - name: PORT
              value: {{ . | quote }}
            {{- end }}
            {{- if $jwt }}
            - name: JWT_PUBLIC_KEY_FILE
              value: /run/keys/jwt-public.pem
            {{- if $jwt.privateKey }}
            - name: JWT_PRIVATE_KEY_FILE
              value: /run/keys/jwt-private.pem
            {{- end }}
            {{- end }}
          {{- end }}
          {{- if or .Values.config $hasSecret }}
          envFrom:
            {{- if .Values.config }}
            - configMapRef:
                name: {{ $fullname }}
            {{- end }}
            {{- if $hasSecret }}
            - secretRef:
                name: {{ include "ecommerce-analytics.secretName" . }}
            {{- end }}
          {{- end }}
          {{- with .Values.port }}
          ports:
            - name: http
              containerPort: {{ . }}
          # The probes every service gets from @ecommerce-analytics/platform (packages/platform/src/health.ts).
          startupProbe:
            httpGet: { path: /health/startup, port: http }
            periodSeconds: 5
            # Up to 5 minutes for migrations and Kafka.
            failureThreshold: 60
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
          readinessProbe:
            # Checks the database and Kafka, each with a 2 s timeout.
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2
          {{- end }}
          {{- with .Values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            {{- if $jwt }}
            - name: jwt
              mountPath: /run/keys
              readOnly: true
            {{- end }}
            {{- if $persistence }}
            - name: data
              mountPath: {{ $persistence.mountPath }}
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: {}
        {{- if $jwt }}
        # The shared key pair (README: "Before the first deploy"). Only auth-service gets the private key.
        - name: jwt
          secret:
            secretName: {{ $jwt.secretName }}
            items:
              - key: jwt-public.pem
                path: jwt-public.pem
              {{- if $jwt.privateKey }}
              - key: jwt-private.pem
                path: jwt-private.pem
              {{- end }}
        {{- end }}
  {{- if $persistence }}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        {{- with $persistence.storageClass }}
        storageClassName: {{ . }}
        {{- end }}
        resources:
          requests:
            storage: {{ $persistence.size }}
  {{- end }}
{{- end -}}
