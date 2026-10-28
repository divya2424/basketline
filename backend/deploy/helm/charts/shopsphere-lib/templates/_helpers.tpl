{{- define "shopsphere.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* The release name when it already contains the chart name, so `helm install gateway charts/gateway` gives "gateway". */}}
{{- define "shopsphere.fullname" -}}
{{- $name := include "shopsphere.name" . -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "shopsphere.selectorLabels" -}}
app.kubernetes.io/name: {{ include "shopsphere.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "shopsphere.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "shopsphere.selectorLabels" . }}
app.kubernetes.io/version: {{ include "shopsphere.imageTag" . | quote }}
app.kubernetes.io/part-of: shopsphere
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "shopsphere.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion -}}
{{- end -}}

{{- define "shopsphere.secretName" -}}
{{- .Values.existingSecret | default (include "shopsphere.fullname" .) -}}
{{- end -}}

{{/* Every resource of a service chart. Each chart's templates/manifests.yaml includes this. */}}
{{- define "shopsphere.all" -}}
{{ include "shopsphere.serviceAccount" . }}
{{ include "shopsphere.configMap" . }}
{{ include "shopsphere.secret" . }}
{{ include "shopsphere.workload" . }}
{{ include "shopsphere.service" . }}
{{ include "shopsphere.ingress" . }}
{{ include "shopsphere.hpa" . }}
{{ include "shopsphere.pdb" . }}
{{- end -}}
