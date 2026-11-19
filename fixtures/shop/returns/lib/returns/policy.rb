module Returns
  class Policy
    DEFAULT_WINDOW = 30

    def self.allowed?(order)
      order && order[:age_in_days] <= window
    end

    def self.window
      Integer(ENV.fetch("RETURN_WINDOW_DAYS", DEFAULT_WINDOW))
    end
  end
end
