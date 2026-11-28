# API tutorial

```python
import os
token = os.getenv("API_TOKEN")
headers = {"Authorization": f"Bearer {token}"}
api_key = os.environ["API_KEY"]
```
Never commit your token to the repository.
