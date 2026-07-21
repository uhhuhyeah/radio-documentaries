.PHONY: test test-quiet

# Run the deterministic-core test suite (stdlib unittest, no deps needed).
test:
	python3 -m unittest discover -s tests -t . -v

test-quiet:
	python3 -m unittest discover -s tests -t .
