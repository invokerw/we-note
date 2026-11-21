package password

import "testing"

func TestHashAndCompare(t *testing.T) {
	hash, err := Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if hash == "correct horse battery staple" || !Compare(hash, "correct horse battery staple") {
		t.Fatal("hashed password did not verify")
	}
	if Compare(hash, "wrong password") {
		t.Fatal("wrong password verified")
	}
}

func TestHashUsesUniqueSalt(t *testing.T) {
	first, err := Hash("same password")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Hash("same password")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("password hashes reused the same salt")
	}
}
