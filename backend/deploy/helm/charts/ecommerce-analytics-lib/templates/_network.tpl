{{- define "ecommerce-analytics.service" -}}
{{- if .Values.port }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "ecommerce-analytics.fullname" . }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
spec:
  type: {{ (.Values.service).type | default "ClusterIP" }}
  selector:
    {{- include "ecommerce-analytics.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.port }}
      targetPort: http
{{- end }}
{{- end -}}

{{- define "ecommerce-analytics.ingress" -}}
{{- with .Values.ingress }}
{{- if .enabled }}
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "ecommerce-analytics.fullname" $ }}
  labels:
    {{- include "ecommerce-analytics.labels" $ | nindent 4 }}
  {{- with .annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- with .tls }}
  tls:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    {{- range .hosts }}
    - host: {{ . | quote }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ include "ecommerce-analytics.fullname" $ }}
                port:
                  name: http
    {{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "ecommerce-analytics.hpa" -}}
{{- with .Values.autoscaling }}
{{- if .enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "ecommerce-analytics.fullname" $ }}
  labels:
    {{- include "ecommerce-analytics.labels" $ | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "ecommerce-analytics.fullname" $ }}
  minReplicas: {{ .minReplicas }}
  maxReplicas: {{ .maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .targetCPUUtilizationPercentage }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Node drains and cluster upgrades take down one pod at a time, once there's more than one. */}}
{{- define "ecommerce-analytics.pdb" -}}
{{- if or (gt (int .Values.replicaCount) 1) (.Values.autoscaling).enabled }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "ecommerce-analytics.fullname" . }}
  labels:
    {{- include "ecommerce-analytics.labels" . | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- include "ecommerce-analytics.selectorLabels" . | nindent 6 }}
{{- end }}
{{- end -}}
