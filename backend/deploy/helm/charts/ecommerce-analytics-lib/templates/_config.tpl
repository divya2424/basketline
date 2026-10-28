{{- define "ecommerce-analytics.serviceAccount" -}}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "ecommerce-analytics.fullname" . }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
# No service talks to the Kubernetes API.
automountServiceAccountToken: false
{{- end -}}

{{/* Non-secret environment variables, from .Values.config. */}}
{{- define "ecommerce-analytics.configMap" -}}
{{- if .Values.config }}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "ecommerce-analytics.fullname" . }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
data:
  {{- range $key, $value := .Values.config }}
  {{ $key }}: {{ $value | quote }}
  {{- end }}
{{- end }}
{{- end -}}

{{/*
Secret environment variables, from .Values.secrets. Every key must have a value,
unless existingSecret names a Secret (yours, e.g. from External Secrets) that has them.
*/}}
{{- define "ecommerce-analytics.secret" -}}
{{- if and .Values.secrets (not .Values.existingSecret) }}
---
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "ecommerce-analytics.fullname" . }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{- range $key, $value := .Values.secrets }}
  {{ $key }}: {{ required (printf "secrets.%s is required (or set existingSecret to a Secret that has it)" $key) $value | quote }}
  {{- end }}
{{- end }}
{{- end -}}
