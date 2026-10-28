{{- define "ecommerce-analytics.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release name when it already contains the chart name, so `helm install gateway charts/gateway` gives "gateway". */}}
{{- define "ecommerce-analytics.fullname" -}}
{{- $name := include "ecommerce-analytics.name" . -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ecommerce-analytics.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ecommerce-analytics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ecommerce-analytics.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "ecommerce-analytics.selectorLabels" . }}
app.kubernetes.io/version: {{ include "ecommerce-analytics.imageTag" . | quote }}
app.kubernetes.io/part-of: ecommerce-analytics
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ecommerce-analytics.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "ecommerce-analytics.secretName" -}}
{{- .Values.existingSecret | default (include "ecommerce-analytics.fullname" .) -}}
{{- end -}}

{{/* Every resource of a service chart. Each chart's templates/manifests.yaml includes this. */}}
{{- define "ecommerce-analytics.all" -}}
{{ include "ecommerce-analytics.serviceAccount" . }}
{{ include "ecommerce-analytics.configMap" . }}
{{ include "ecommerce-analytics.secret" . }}
{{ include "ecommerce-analytics.workload" . }}
{{ include "ecommerce-analytics.service" . }}
{{ include "ecommerce-analytics.ingress" . }}
{{ include "ecommerce-analytics.hpa" . }}
{{ include "ecommerce-analytics.pdb" . }}
{{- end -}}
