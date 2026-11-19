package invoice

// Service adds up what a customer owes.
type Service struct {
	Store *Store
}

func (s *Service) Total(customer string) int {
	amounts := s.Store.Load(customer)
	return sum(amounts)
}
