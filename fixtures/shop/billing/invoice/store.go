package invoice

import "fmt"

type Store struct {
	region string
}

func NewStore(region string) *Store {
	return &Store{region: region}
}

func (st *Store) Load(customer string) []int {
	query := "SELECT amount FROM invoices WHERE customer = ? AND region = ?"
	return run(query, customer, st.region)
}

func run(query string, args ...string) []int {
	return []int{len(query), len(args)}
}

func sum(amounts []int) int {
	total := 0
	for _, amount := range amounts {
		total += amount
	}
	return total
}

func Format(total int) string {
	return fmt.Sprintf("%d.00", total)
}
