package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/weifei/we-note/services/api/internal/model"
	"github.com/weifei/we-note/services/api/internal/store"
)

var syncTimestampPattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$`)
var syncHashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

var supportedSyncOperations = []string{
	"create_file",
	"update_file_content",
	"rename_file",
	"move_file",
	"delete_file",
	"restore_file",
	"create_directory",
	"rename_directory",
	"move_directory",
	"delete_directory",
	"restore_directory",
	"set_file_metadata",
}

func (a *API) syncChanges(w http.ResponseWriter, r *http.Request) {
	endpoint := r.URL.Path
	if r.Method != http.MethodPost {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  405,
			Code:    "METHOD_NOT_ALLOWED",
			Message: "该同步端点只接受 POST 请求。",
		})
		return
	}
	body, rawBody, syncErr := decodeSyncObject(w, r)
	if syncErr != nil {
		a.writeSyncError(w, r, endpoint, "POST", "", syncErr)
		return
	}
	var err error
	mode, modeOK := jsonString(body["mode"])
	if !modeOK || (mode != "submit" && mode != "pull") {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  400,
			Code:    "MODE_REQUIRED",
			Message: "mode 必须是 submit 或 pull。",
			Fields:  map[string]any{"requested_mode": rawValue(body["mode"])},
		})
		return
	}
	vaultID, deviceID, missing := requiredIdentifiers(body)
	if len(missing) > 0 {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "请求缺少有效的 Vault 或设备标识。",
			Fields:  map[string]any{"missing_fields": missing},
		})
		return
	}
	if queryVaultID, present := queryParameter(r, "vault_id"); present && queryVaultID != vaultID {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  404,
			Code:    "VAULT_MISMATCH",
			Message: "查询参数 vault_id 与路由不一致。",
			Fields: map[string]any{
				"vault_id":          queryVaultID,
				"expected_vault_id": vaultID,
			},
		})
		return
	}
	if vaultID != r.PathValue("vault_id") {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  400,
			Code:    "VAULT_MISMATCH",
			Message: "请求体 vault_id 与路由不一致。",
			Fields: map[string]any{
				"vault_id":          vaultID,
				"expected_vault_id": r.PathValue("vault_id"),
			},
		})
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	canAccess, err := a.repository.DeviceCanAccessVault(r.Context(), user.ID, vaultID, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate sync access")
		return
	}
	if !canAccess {
		a.writeSyncError(w, r, endpoint, "POST", "", &store.SyncError{
			Status:  404,
			Code:    "VAULT_MISMATCH",
			Message: "设备无权访问该 Vault。",
			Fields: map[string]any{
				"vault_id":          vaultID,
				"expected_vault_id": vaultID,
			},
		})
		return
	}
	requestID, requestIDErr := a.repository.NextSyncRequestID(r.Context(), r.PathValue("vault_id"))
	if requestIDErr != nil {
		a.writeSyncError(w, r, endpoint, "POST", requestID, requestIDErr)
		return
	}
	if mode == "pull" {
		cursor, validationErr := parseNonNegativeInt(body, "last_server_revision")
		if validationErr != nil {
			a.writeSyncError(w, r, endpoint, "POST", requestID, validationErr)
			return
		}
		result, err := a.repository.PullSyncChanges(r.Context(), vaultID, deviceID, cursor)
		if err != nil {
			a.writeSyncError(w, r, endpoint, "POST", requestID, err)
			return
		}
		response := mapFromValue(result)
		writeSyncSuccess(w, requestID, response, endpoint, r.Method)
		return
	}

	request, validationErr := parseSubmitRequest(body)
	if validationErr != nil {
		a.writeSyncError(w, r, endpoint, "POST", requestID, validationErr)
		return
	}
	request.VaultID = vaultID
	request.DeviceID = deviceID
	request.Fingerprint, err = store.FingerprintRequest(body)
	if err != nil {
		a.writeSyncError(w, r, endpoint, "POST", requestID, &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "请求无法建立稳定指纹。",
		})
		return
	}
	request.RequestJSON = string(rawBody)
	request.RequestID = requestID
	if idempotencyKey := requestHeaderValue(r.Header, "Idempotency-Key"); idempotencyKey != "" && idempotencyKey != request.OperationID {
		a.writeSyncError(w, r, endpoint, "POST", requestID, &store.SyncError{
			Status:  400,
			Code:    "IDEMPOTENCY_KEY_MISMATCH",
			Message: "Idempotency-Key 必须等于 operation_id。",
			Fields: map[string]any{
				"idempotency_key": idempotencyKey,
				"operation_id":    request.OperationID,
			},
		})
		return
	}
	canWrite, err := a.repository.DeviceCanWriteVault(r.Context(), user.ID, vaultID, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate sync write access")
		return
	}
	if !canWrite {
		a.writeSyncError(w, r, endpoint, "POST", requestID, &store.SyncError{
			Status:  403,
			Code:    "FORBIDDEN",
			Message: "设备没有写入该 Vault 的权限。",
		})
		return
	}
	result, err := a.repository.SubmitSyncChange(r.Context(), request)
	if err != nil {
		a.writeSyncError(w, r, endpoint, "POST", requestID, err)
		return
	}
	response := mapFromValue(result)
	if result.Replayed {
		response["original_request_id"] = result.OriginalRequestID
	}
	writeSyncSuccess(w, requestID, response, endpoint, r.Method)
}

func (a *API) syncManifest(w http.ResponseWriter, r *http.Request) {
	endpoint := r.URL.Path
	if r.Method != http.MethodGet {
		a.writeSyncError(w, r, endpoint, "GET", "", &store.SyncError{
			Status:  405,
			Code:    "METHOD_NOT_ALLOWED",
			Message: "该同步端点只接受 GET 请求。",
		})
		return
	}
	vaultID := r.PathValue("vault_id")
	deviceID := requestHeaderValue(r.Header, "X-Device-Id")
	if deviceID == "" {
		deviceID = r.URL.Query().Get("device_id")
	}
	if deviceID == "" {
		a.writeSyncError(w, r, endpoint, "GET", "", &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "device_id 是必填的非空字符串。",
			Fields:  map[string]any{"missing_fields": []string{"device_id"}},
		})
		return
	}
	if queryVaultID, present := queryParameter(r, "vault_id"); present && queryVaultID != vaultID {
		a.writeSyncError(w, r, endpoint, "GET", "", &store.SyncError{
			Status:  404,
			Code:    "VAULT_MISMATCH",
			Message: "查询参数 vault_id 与路由不一致。",
			Fields: map[string]any{
				"vault_id":          queryVaultID,
				"expected_vault_id": vaultID,
			},
		})
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	canAccess, err := a.repository.DeviceCanAccessVault(r.Context(), user.ID, vaultID, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate manifest access")
		return
	}
	if !canAccess {
		a.writeSyncError(w, r, endpoint, "GET", "", &store.SyncError{
			Status:  404,
			Code:    "VAULT_MISMATCH",
			Message: "设备无权访问该 Vault。",
			Fields: map[string]any{
				"vault_id":          vaultID,
				"expected_vault_id": vaultID,
			},
		})
		return
	}
	requestID, requestIDErr := a.repository.NextSyncRequestID(r.Context(), r.PathValue("vault_id"))
	if requestIDErr != nil {
		a.writeSyncError(w, r, endpoint, "GET", requestID, requestIDErr)
		return
	}
	result, err := a.repository.Manifest(r.Context(), vaultID, deviceID)
	if err != nil {
		a.writeSyncError(w, r, endpoint, "GET", requestID, err)
		return
	}
	writeSyncSuccess(w, requestID, mapFromValue(result), endpoint, r.Method)
}

func (a *API) createUploadSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "upload session creation requires POST")
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vaultID := r.PathValue("vault_id")
	var request struct {
		ContentHash string `json:"content_hash"`
		ContentSize int64  `json:"content_size"`
	}
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	canWrite, err := a.repository.UserCanWriteVault(r.Context(), user.ID, vaultID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate upload access")
		return
	}
	if !canWrite {
		writeError(w, http.StatusForbidden, "FORBIDDEN", "upload access is not available for this Vault")
		return
	}
	session, err := a.repository.CreateUploadSession(r.Context(), vaultID, request.ContentHash, request.ContentSize)
	if err != nil {
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

func (a *API) getUploadSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "upload session lookup requires GET")
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vaultID := r.PathValue("vault_id")
	canAccess, err := a.repository.UserCanAccessVault(r.Context(), user.ID, vaultID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate upload access")
		return
	}
	if !canAccess {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "upload session not found")
		return
	}
	session, err := a.repository.UploadSession(r.Context(), vaultID, r.PathValue("upload_id"))
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "upload session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not load upload session")
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func (a *API) completeUploadSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "upload completion requires POST")
		return
	}
	user, ok := a.authenticatedUser(w, r)
	if !ok {
		return
	}
	vaultID := r.PathValue("vault_id")
	canWrite, err := a.repository.UserCanWriteVault(r.Context(), user.ID, vaultID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "could not validate upload access")
		return
	}
	if !canWrite {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "upload session not found")
		return
	}
	session, err := a.repository.CompleteUploadSession(r.Context(), vaultID, r.PathValue("upload_id"), r.Body)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "upload session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusConflict, "UPLOAD_FAILED", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func requestHeaderValue(headers http.Header, name string) string {
	for key, values := range headers {
		if strings.EqualFold(key, name) && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func queryParameter(r *http.Request, name string) (string, bool) {
	values, present := r.URL.Query()[name]
	if !present || len(values) != 1 {
		return "", present
	}
	return values[0], true
}

func decodeSyncObject(w http.ResponseWriter, r *http.Request) (map[string]json.RawMessage, []byte, *store.SyncError) {
	if r.Body == nil {
		return nil, nil, &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "JSON 请求体是必需的。",
			Fields:  map[string]any{"body_error": "request body is required"},
		}
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		return nil, nil, &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "请求体读取失败。",
			Fields:  map[string]any{"body_error": err.Error()},
		}
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(body, &object); err != nil || object == nil {
		if err == nil {
			err = fmt.Errorf("JSON body must be an object")
		}
		return nil, nil, &store.SyncError{
			Status:  400,
			Code:    "INVALID_REQUEST",
			Message: "请求体不是合法 JSON 对象。",
			Fields:  map[string]any{"body_error": err.Error()},
		}
	}
	return object, body, nil
}

func requiredIdentifiers(body map[string]json.RawMessage) (string, string, []string) {
	vaultID, vaultOK := jsonString(body["vault_id"])
	deviceID, deviceOK := jsonString(body["device_id"])
	missing := make([]string, 0, 2)
	if !vaultOK || vaultID == "" {
		missing = append(missing, "vault_id")
	}
	if !deviceOK || deviceID == "" {
		missing = append(missing, "device_id")
	}
	return vaultID, deviceID, missing
}

func parseSubmitRequest(body map[string]json.RawMessage) (store.SyncSubmitRequest, *store.SyncError) {
	var request store.SyncSubmitRequest
	missing := make([]string, 0)
	readString := func(name string, target *string) {
		value, ok := jsonString(body[name])
		if !ok || value == "" {
			missing = append(missing, name)
			return
		}
		*target = value
	}
	readString("operation_id", &request.OperationID)
	readString("file_id", &request.FileID)
	readString("operation", &request.Operation)
	readString("path", &request.Path)
	readString("blob_reference", &request.BlobReference)
	readString("content_hash", &request.ContentHash)
	readString("client_timestamp", &request.ClientTimestamp)
	if len(missing) > 0 {
		return request, invalidRequest(missing)
	}
	baseRevision, err := parseNonNegativeInt(body, "base_revision")
	if err != nil {
		return request, err
	}
	request.BaseRevision = baseRevision
	contentSize, err := parseNonNegativeInt(body, "content_size")
	if err != nil {
		return request, err
	}
	request.ContentSize = contentSize
	if !syncHashPattern.MatchString(request.ContentHash) {
		return request, invalidRequest([]string{"content_hash"})
	}
	if !validSyncPath(request.Path) {
		return request, invalidRequest([]string{"path"})
	}
	if !validSyncTimestamp(request.ClientTimestamp) {
		return request, invalidRequest([]string{"client_timestamp"})
	}
	metadata, err := parseMetadata(body["metadata"])
	if err != nil {
		return request, err
	}
	request.Metadata = metadata
	baseVersionID, baseVersionPresent, baseVersionValid := optionalString(body, "base_version_id")
	baseHash, baseHashPresent, baseHashValid := optionalString(body, "base_content_hash")
	if !baseVersionValid || !baseHashValid {
		return request, invalidRequest([]string{"base_version_id", "base_content_hash"})
	}
	if baseVersionPresent {
		if baseVersionID == "" {
			return request, invalidRequest([]string{"base_version_id"})
		}
		request.BaseVersionID = &baseVersionID
	}
	if baseHashPresent {
		if !syncHashPattern.MatchString(baseHash) {
			return request, invalidRequest([]string{"base_content_hash"})
		}
		request.BaseContentHash = &baseHash
	}
	if request.BaseVersionID == nil && request.BaseContentHash == nil {
		return request, &store.SyncError{
			Status:  400,
			Code:    "BASE_REQUIRED",
			Message: "至少需要提供 base_version_id 或 base_content_hash。",
			Fields:  map[string]any{"file_id": request.FileID},
		}
	}
	if request.Operation != "update_file_content" {
		return request, &store.SyncError{
			Status:  400,
			Code:    "OPERATION_NOT_SUPPORTED",
			Message: "该 operation 尚未在同步协议 v1 中实现。",
			Fields: map[string]any{
				"operation":             request.Operation,
				"supported_operations":  supportedSyncOperations,
				"executable_operations": []string{"update_file_content"},
			},
		}
	}
	return request, nil
}

func parseMetadata(raw json.RawMessage) (model.Metadata, *store.SyncError) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return model.Metadata{}, invalidRequest([]string{"metadata"})
	}
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(raw, &metadata); err != nil || metadata == nil {
		return model.Metadata{}, invalidRequest([]string{"metadata"})
	}
	format, ok := jsonString(metadata["format"])
	if !ok || (format != "md" && format != "txt" && format != "json" && format != "xmind") {
		return model.Metadata{}, invalidRequest([]string{"metadata.format"})
	}
	lineEnding, present, valid := optionalString(metadata, "line_ending")
	if !valid || (present && lineEnding != "lf" && lineEnding != "crlf") {
		return model.Metadata{}, invalidRequest([]string{"metadata.line_ending"})
	}
	return model.Metadata{Format: format, LineEnding: lineEnding}, nil
}

func parseNonNegativeInt(body map[string]json.RawMessage, field string) (int64, *store.SyncError) {
	raw, ok := body[field]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return 0, invalidRequest([]string{field})
	}
	var value int64
	if err := json.Unmarshal(raw, &value); err != nil || value < 0 {
		return 0, invalidRequest([]string{field})
	}
	return value, nil
}

func optionalString(body map[string]json.RawMessage, field string) (string, bool, bool) {
	raw, present := body[field]
	if !present || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false, true
	}
	value, ok := jsonString(raw)
	return value, true, ok
}

func jsonString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func rawValue(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func invalidRequest(fields []string) *store.SyncError {
	return &store.SyncError{
		Status:  400,
		Code:    "INVALID_REQUEST",
		Message: "请求字段无效。",
		Fields:  map[string]any{"missing_fields": fields},
	}
}

func validSyncPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") || strings.Contains(path, "\x00") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func validSyncTimestamp(value string) bool {
	match := syncTimestampPattern.FindStringSubmatch(value)
	if match == nil {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func mapFromValue(value any) map[string]any {
	encoded, _ := json.Marshal(value)
	var result map[string]any
	_ = json.Unmarshal(encoded, &result)
	return result
}

func writeSyncSuccess(w http.ResponseWriter, requestID string, body map[string]any, endpoint, method string) {
	body["protocol_version"] = "sync-v1"
	body["request_id"] = requestID
	body["endpoint"] = endpoint
	body["method"] = method
	body["allowed_method"] = http.MethodPost
	if body["mode"] == "manifest" {
		body["allowed_method"] = http.MethodGet
	}
	writeJSON(w, http.StatusOK, body)
}

func (a *API) writeSyncError(w http.ResponseWriter, r *http.Request, endpoint, allowedMethod, requestID string, err error) {
	status := http.StatusInternalServerError
	code := "INTERNAL_ERROR"
	message := "同步请求处理失败。"
	fields := map[string]any{}
	if syncErr, ok := err.(*store.SyncError); ok {
		status = syncErr.Status
		code = syncErr.Code
		message = syncErr.Message
		fields = syncErr.Fields
	}
	body := map[string]any{
		"protocol_version": "sync-v1",
		"request_id":       anyStringOrNil(requestID),
		"code":             code,
		"message":          message,
		"endpoint":         endpoint,
		"method":           r.Method,
		"allowed_method":   allowedMethod,
	}
	for key, value := range fields {
		body[key] = value
	}
	writeJSON(w, status, body)
}

func anyStringOrNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}
