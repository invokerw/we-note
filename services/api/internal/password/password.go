package password

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	algorithm  = "pbkdf2-sha256"
	iterations = 120000
	saltBytes  = 16
	keyBytes   = 32
)

func Hash(plainText string) (string, error) {
	if plainText == "" {
		return "", errors.New("password is required")
	}
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	derived := derive([]byte(plainText), salt, iterations, keyBytes)
	encoding := base64.RawURLEncoding
	return strings.Join([]string{
		algorithm,
		strconv.Itoa(iterations),
		encoding.EncodeToString(salt),
		encoding.EncodeToString(derived),
	}, "$"), nil
}

func Compare(encoded, plainText string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != algorithm || plainText == "" {
		return false
	}
	parsedIterations, err := strconv.Atoi(parts[1])
	if err != nil || parsedIterations < 1 {
		return false
	}
	encoding := base64.RawURLEncoding
	salt, err := encoding.DecodeString(parts[2])
	if err != nil || len(salt) < 8 {
		return false
	}
	expected, err := encoding.DecodeString(parts[3])
	if err != nil || len(expected) == 0 {
		return false
	}
	actual := derive([]byte(plainText), salt, parsedIterations, len(expected))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func derive(password, salt []byte, rounds, length int) []byte {
	result := make([]byte, 0, length)
	for block := uint32(1); len(result) < length; block++ {
		mac := hmac.New(sha256.New, password)
		mac.Write(salt)
		mac.Write([]byte{byte(block >> 24), byte(block >> 16), byte(block >> 8), byte(block)})
		u := mac.Sum(nil)
		accumulator := append([]byte(nil), u...)
		for round := 1; round < rounds; round++ {
			mac = hmac.New(sha256.New, password)
			mac.Write(u)
			u = mac.Sum(nil)
			for index := range accumulator {
				accumulator[index] ^= u[index]
			}
		}
		result = append(result, accumulator...)
	}
	return result[:length]
}
