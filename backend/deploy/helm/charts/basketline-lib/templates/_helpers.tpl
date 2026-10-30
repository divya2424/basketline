{{- define "basketline.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release name when it already contains the chart name, so `helm install gateway charts/gateway` gives "gateway". */}}
{{- define "basketline.fullname" -}}
{{- $name := include "basketline.name" . -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "basketline.selectorLabels" -}}
app.kubernetes.io/name: {{ include "basketline.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "basketline.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "basketline.selectorLabels" . }}
app.kubernetes.io/version: {{ include "basketline.imageTag" . | quote }}
app.kubernetes.io/part-of: basketline
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "basketline.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "basketline.secretName" -}}
{{- .Values.existingSecret | default (include "basketline.fullname" .) -}}
{{- end -}}

{{/* Every resource of a service chart. Each chart's templates/manifests.yaml includes this. */}}
{{- define "basketline.all" -}}
{{ include "basketline.serviceAccount" . }}
{{ include "basketline.configMap" . }}
{{ include "basketline.secret" . }}
{{ include "basketline.workload" . }}
{{ include "basketline.service" . }}
{{ include "basketline.ingress" . }}
{{ include "basketline.hpa" . }}
{{ include "basketline.pdb" . }}
{{- end -}}
