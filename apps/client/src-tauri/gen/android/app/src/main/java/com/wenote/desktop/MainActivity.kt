package com.wenote.desktop

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    val lightBars = SystemBarStyle.light(Color.TRANSPARENT, Color.DKGRAY)
    enableEdgeToEdge(statusBarStyle = lightBars, navigationBarStyle = lightBars)
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.WHITE)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
