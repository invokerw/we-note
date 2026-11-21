package password

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"

	"golang.org/x/crypto/argon2"
)

const argonPrefix = "$argon2id$v=19$m=65536,t=3,p=4$"
const keyBytes = 32

// Cap simultaneous 64 MiB derivations on a personal server.
var derivations = make(chan struct{}, 2)

func deriveArgon(plain string, salt []byte) []byte {
	derivations <- struct{}{}
	defer func() { <-derivations }()
	return argon2.IDKey([]byte(plain), salt, 3, 64*1024, 4, keyBytes)
}
func Hash(plain string) (string, error) {
	if plain == "" {
		return "", errors.New("password is required")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	enc := base64.RawStdEncoding
	return argonPrefix + enc.EncodeToString(salt) + "$" + enc.EncodeToString(deriveArgon(plain, salt)), nil
}
func Compare(encoded, plain string) bool {
	if plain == "" {
		return false
	}
	legacy := false
	params, ok := strings.CutPrefix(encoded, argonPrefix)
	enc := base64.RawStdEncoding
	if !ok {
		params, ok = strings.CutPrefix(encoded, "pbkdf2-sha256$120000$")
		if !ok {
			return false
		}
		legacy = true
		enc = base64.RawURLEncoding
	}
	a, b, ok := strings.Cut(params, "$")
	if !ok {
		return false
	}
	salt, err := enc.DecodeString(a)
	if err != nil || len(salt) != 16 {
		return false
	}
	want, err := enc.DecodeString(b)
	if err != nil || len(want) != keyBytes {
		return false
	}
	var actual []byte
	if legacy {
		actual, err = pbkdf2.Key(sha256.New, plain, salt, 120000, keyBytes)
		if err != nil {
			return false
		}
	} else {
		actual = deriveArgon(plain, salt)
	}
	return subtle.ConstantTimeCompare(actual, want) == 1
}
